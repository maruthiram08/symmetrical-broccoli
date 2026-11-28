// One classification for every provider's errors: the same five kinds as Anthropic's
// (src/lib/extract/errors.ts), so retries, banners and "fix your key" messages work the same.
import { AnthropicCallError, classifyAnthropicError, type AnthropicFailure } from "../extract/errors";

/** The HTTP status, whatever the SDK calls it (status, statusCode, or Gemini's numeric code). */
export function statusOf(e: unknown): number | null {
  const x = (e ?? {}) as { status?: unknown; statusCode?: unknown; code?: unknown };
  for (const v of [x.status, x.statusCode, x.code]) if (typeof v === "number" && v >= 100 && v < 600) return v;
  return null;
}

function bodyOf(e: unknown): string {
  const x = (e ?? {}) as { message?: unknown; error?: unknown; body?: unknown; code?: unknown };
  return [x.message, x.body, typeof x.code === "string" ? x.code : "", JSON.stringify(x.error ?? "")].map((v) => (typeof v === "string" ? v : "")).join(" ");
}

/**
 * auth / credit / transient / offline / bad_request for any provider:
 * - 402 (OpenRouter, DeepSeek: out of balance) and OpenAI's 429 "insufficient_quota" are credit;
 * - everything else goes through the Anthropic rules (401/403 auth, 429/5xx/timeouts transient...).
 */
export function classifyProviderError(e: unknown): AnthropicFailure {
  if (e instanceof AnthropicCallError) return e.kind;
  const status = statusOf(e);
  const body = bodyOf(e);
  if (status === 402) return "credit";
  if ((status === 429 || status === 400 || status === 403) && /insufficient[_ ]quota|insufficient balance|credit balance|out of credits?|billing|purchase credits/i.test(body)) return "credit";
  if (status === 400 && /api[_ ]key[_ ]invalid|invalid api key|api key not valid/i.test(body)) return "auth";
  const x = (e ?? {}) as { name?: string; message?: string; error?: unknown };
  return classifyAnthropicError({ name: x.name, message: x.message, error: x.error, status: status ?? undefined, cause: (e as { cause?: unknown })?.cause, code: (e as { code?: unknown })?.code });
}

/** Rethrow any provider error as AnthropicCallError (kind + status, never the body). */
export function toCallError(e: unknown): AnthropicCallError {
  if (e instanceof AnthropicCallError) return e;
  return new AnthropicCallError(classifyProviderError(e), statusOf(e));
}

/**
 * What to tell someone waiting, for a failure of the named provider. With the default label
 * ("Anthropic", "Claude") these are the words Ask and writing assist always used.
 */
export function failureMessage(failure: AnthropicFailure, who: { account: string; model: string } = { account: "Anthropic", model: "Claude" }, retry = "try again"): string {
  switch (failure) {
    case "auth": return `Your ${who.account} API key was rejected. Check it in Settings.`;
    case "credit": return `Your ${who.account} account is out of credit. Add credit, then ${retry}.`;
    case "offline": return `Couldn't reach ${who.model}. Check your connection and try again.`;
    case "transient": return `${who.model} is busy right now. Try again in a minute.`;
    default: return `${who.model} couldn't do that one. Try again.`;
  }
}
