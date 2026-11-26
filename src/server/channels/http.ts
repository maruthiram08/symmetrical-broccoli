import { redact } from "@/server/local/log";

/** fetch, injected so tests never reach the network. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** A send that failed. The message is short, built by us and redacted: safe for logs and Health. */
export class ChannelError extends Error {
  constructor(message: string, readonly status?: number) {
    super(redact(message).slice(0, 160));
    this.name = "ChannelError";
  }
}

export const HTTP_TIMEOUT_MS = 15_000;

/**
 * POST JSON (or GET when body is undefined) and return the parsed reply. Throws ChannelError on a
 * network failure or a non-2xx status, naming only the status and the API's short error code.
 */
export async function callJson(
  fetchFn: Fetch,
  url: string,
  opts: { body?: unknown; form?: Record<string, string>; headers?: Record<string, string>; service: string; errorCode?: (json: unknown) => string | null },
): Promise<unknown> {
  let res: Response;
  const form = opts.form ? new URLSearchParams(opts.form).toString() : undefined;
  const body = form ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
  const type = form ? "application/x-www-form-urlencoded" : "application/json; charset=utf-8";
  try {
    res = await fetchFn(url, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...(body === undefined ? {} : { "content-type": type }), ...opts.headers },
      body,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (e) {
    const what = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError") ? "timed out" : "couldn't be reached";
    throw new ChannelError(`${opts.service} ${what}`);
  }
  const raw = await res.text().catch(() => "");
  let json: unknown = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    json = raw;
  }
  const code = opts.errorCode?.(json) ?? null;
  if (!res.ok || code) {
    throw new ChannelError(`${opts.service} HTTP ${res.status}${code ? ` ${code}` : ""}`, res.status);
  }
  return json;
}

/** A short, safe error code from an API reply: its first word, word characters only, at most 60. */
export function safeCode(v: unknown): string | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v).trim().split(/\s+/)[0].replace(/[^\w.-]/g, "").slice(0, 60);
  return s || null;
}
