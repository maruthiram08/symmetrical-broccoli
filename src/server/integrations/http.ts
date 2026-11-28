// One small JSON-over-HTTP helper for the providers. `fetch` is injected so tests never reach the network.

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

const TIMEOUT_MS = 15_000;

/** A short, safe reason for Settings: never echoes a token, and keeps a provider's message short. */
export function reason(e: unknown): string {
  if (e instanceof HttpError) {
    if (e.status === 401 || e.status === 403) return "The token was refused. Check it and its permissions.";
    if (e.status === 404) return "Not found. Check the site, project, team or database.";
    if (e.status === 429) return "Rate limited by the service. Try again in a minute.";
    return `The service answered ${e.status}${e.message ? `: ${e.message}` : ""}.`;
  }
  if (e instanceof Error && e.name === "TimeoutError") return "The service didn't answer in time.";
  if (e instanceof Error && e.message && !/token|key|secret/i.test(e.message)) return e.message;
  return "Couldn't reach the service.";
}

/** The first error message a provider put in its JSON body, cut short. */
function bodyMessage(text: string): string {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const m =
      (Array.isArray(j.errorMessages) && j.errorMessages[0]) ||
      (j.errors && typeof j.errors === "object" && !Array.isArray(j.errors) && Object.values(j.errors as object)[0]) ||
      (Array.isArray(j.errors) && (j.errors[0] as { message?: string })?.message) ||
      j.message || j.error;
    return typeof m === "string" ? m.slice(0, 160) : "";
  } catch {
    return "";
  }
}

export async function requestJson<T>(fetchFn: Fetch, url: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  const res = await fetchFn(url, {
    ...rest,
    headers: { Accept: "application/json", ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
    signal: rest.signal ?? AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, bodyMessage(text));
  return (text ? JSON.parse(text) : {}) as T;
}
