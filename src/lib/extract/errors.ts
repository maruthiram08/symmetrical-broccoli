// What went wrong with an Anthropic API call, and whether trying again can help.

/**
 * - auth: the API key is missing, wrong or revoked (401/403). Nothing helps until the user fixes it.
 * - credit: the account is out of credit (400 "credit balance is too low").
 * - transient: rate limit, overload, 5xx, timeout. Retry with backoff, then try again later.
 * - offline: the request never reached Anthropic (no network). Try again later.
 * - bad_request: any other 4xx. Retrying the same request won't help.
 */
export type AnthropicFailure = "auth" | "credit" | "transient" | "offline" | "bad_request";

/** An Anthropic call that failed. The message is ours, never the response body (it could echo input). */
export class AnthropicCallError extends Error {
  constructor(readonly kind: AnthropicFailure, readonly status: number | null) {
    super(`Anthropic API call failed: ${kind}${status ? ` (HTTP ${status})` : ""}`);
    this.name = "AnthropicCallError";
  }
}

const NETWORK_CODES = /^(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ENETDOWN|EPIPE|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT)$/;

/** True for errors that mean "the network isn't there" rather than "the server said no". */
export function isNetworkError(e: unknown): boolean {
  for (let cur: unknown = e, depth = 0; cur && depth < 4; depth++) {
    const x = cur as { name?: string; code?: string; message?: string; cause?: unknown };
    if (typeof x.code === "string" && NETWORK_CODES.test(x.code)) return true;
    if (x.name === "APIConnectionError") return true;
    if (x.name === "TypeError" && /fetch failed|network|socket/i.test(x.message ?? "")) return true;
    cur = x.cause;
  }
  return false;
}

export function classifyAnthropicError(e: unknown): AnthropicFailure {
  if (e instanceof AnthropicCallError) return e.kind;
  const x = (e ?? {}) as { name?: string; status?: number; message?: string; error?: unknown };
  const status = typeof x.status === "number" ? x.status : null;
  const body = JSON.stringify(x.error ?? "") + " " + (x.message ?? "");
  if (status === 401 || status === 403) return "auth";
  if (status === 400 && /credit balance|billing|purchase credits/i.test(body)) return "credit";
  if (status === 408 || status === 409 || status === 429 || (status !== null && status >= 500)) return "transient";
  if (x.name === "APIConnectionTimeoutError" || x.name === "TimeoutError" || x.name === "AbortError" || /timed? ?out/i.test(x.message ?? "")) return "transient";
  if (status === null && isNetworkError(e)) return "offline";
  if (status !== null && status >= 400) return "bad_request";
  return status === null && x.name === "APIConnectionError" ? "offline" : "transient";
}

function retryAfterMs(e: unknown): number | null {
  const h = (e as { headers?: { get?: (k: string) => string | null } | Record<string, string> })?.headers;
  if (!h) return null;
  const v = typeof (h as { get?: unknown }).get === "function" ? (h as { get: (k: string) => string | null }).get("retry-after") : (h as Record<string, string>)["retry-after"];
  const sec = v ? Number(v) : NaN;
  return Number.isFinite(sec) && sec >= 0 ? sec * 1000 : null;
}

export interface RetryOpts {
  /** Retries after the first try. */
  retries?: number;
  baseMs?: number;
  maxMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Call fn, retrying transient failures (429, 529, 5xx, timeouts) with exponential backoff and
 * jitter, honouring retry-after. Key and credit problems fail at once. The final error is an
 * AnthropicCallError (kind + status only).
 */
export async function withAnthropicRetry<T>(fn: () => PromiseLike<T>, opts: RetryOpts = {}): Promise<T> {
  const retries = opts.retries ?? 3;
  const base = opts.baseMs ?? 2_000;
  const max = opts.maxMs ?? 60_000;
  const sleep = opts.sleep ?? realSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const kind = classifyAnthropicError(e);
      const status = typeof (e as { status?: unknown })?.status === "number" ? (e as { status: number }).status : null;
      if (kind !== "transient" || attempt >= retries) throw new AnthropicCallError(kind, status);
      const backoff = Math.min(max, base * 4 ** attempt) * (0.75 + Math.random() * 0.5);
      await sleep(Math.min(max, retryAfterMs(e) ?? backoff));
    }
  }
}
