import type { BriefModel, ExtractionInput, ExtractionResult, Meeting, User } from "@/lib/types";
import type { Store } from "@/server/store";
import type { WisprClient } from "@/server/wispr/client";
import { errLine, redact } from "@/server/local/log";

/** Everything a job touches. Built for production in src/server/deps.ts; tests pass fakes. */
export interface Deps {
  store: Store;
  wispr: (userId: string) => WisprClient;
  extract: (input: ExtractionInput) => Promise<ExtractionResult>;
  costInr: (model: string, usage: { inputTokens: number; outputTokens: number }) => number;
  /** Model name recorded with extract_run events (cost lookup). */
  model: string;
  buildBrief: (store: Store, user: User, now: Date) => Promise<BriefModel>;
  renderMarkdown: (model: BriefModel) => string;
  /** Hand the finished brief to the user: on the local app, write the note and show a notification. */
  /** On Fridays `week` carries the weekly recap (week-YYYY-Www.md). */
  publish: (user: User, model: BriefModel, markdown: string, week?: { key: string; markdown: string }) => Promise<{ id: string }>;
  now: () => Date;
  /** Transcript of a meeting from a local recorder (Granola, Zoom, files). Default: src/server/recorders. */
  localTranscript?: (meeting: Meeting, user: User) => Promise<string>;
}

/**
 * Log a job failure. Only the error's name and a short message are kept; for the process job
 * the message is dropped entirely so no transcript text can reach the events table.
 * Never throws.
 */
export async function logJobError(
  deps: { store: Pick<Store, "logEvent"> },
  userId: string | null,
  job: string,
  err: unknown,
  extra: Record<string, unknown> = {},
  opts: { includeMessage?: boolean } = {},
): Promise<void> {
  const e = err instanceof Error ? err : new Error(String(err));
  const payload: Record<string, unknown> = { job, error: e.name, ...extra };
  if (opts.includeMessage !== false) payload.message = redact(e.message).slice(0, 200);
  try {
    await deps.store.logEvent({ userId, type: "job_error", payload });
  } catch (logErr) {
    console.error(`[${job}] could not log error: ${errLine(logErr)}`);
  }
  console.error(`[${job}] user=${userId ?? "-"} ${errLine(e, { message: opts.includeMessage !== false })}`);
}

/** Run fn over items with at most `limit` in flight. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
