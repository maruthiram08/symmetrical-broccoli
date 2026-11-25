import { QUOTE_MAX, type ExtractionResult } from "@/lib/types";
import type { WisprClient } from "@/server/wispr/client";
import { ReconnectRequiredError } from "@/server/wispr/oauth";
import { logJobError, mapLimit, type Deps } from "./types";

export type ProcessResult =
  | { status: "processed"; newItems: number; closes: number }
  | { status: "skipped"; reason: "not_found" | "already_processed" | "no_user" };

/**
 * Error raised by processMeeting. It carries only a stage and the original error's name, never its
 * message, because messages from the transcript fetch or the model call may echo transcript text.
 */
export class ProcessError extends Error {
  constructor(public stage: "transcript" | "extract" | "commit", public causeName: string) {
    super(`processing failed at ${stage} (${causeName})`);
    this.name = "ProcessError";
  }
}

const clip = (s: string) => (s.length > QUOTE_MAX ? s.slice(0, QUOTE_MAX - 1) + "…" : s);

/**
 * Extract items from one meeting and commit them atomically. Idempotent: an already-processed
 * meeting is skipped. The transcript lives only in this function's scope: it is never stored,
 * logged or attached to an error.
 */
export async function processMeeting(
  deps: Pick<Deps, "store" | "wispr" | "extract" | "costInr" | "model" | "now">,
  meetingId: string,
  opts: { client?: WisprClient } = {},
): Promise<ProcessResult> {
  const { store } = deps;
  const meeting = await store.getMeeting(meetingId);
  if (!meeting) return { status: "skipped", reason: "not_found" };
  if (meeting.processedAt) return { status: "skipped", reason: "already_processed" };
  const user = await store.getUser(meeting.userId);
  if (!user) return { status: "skipped", reason: "no_user" };

  const client = opts.client ?? deps.wispr(meeting.userId);
  let result: ExtractionResult;
  let openIds: Set<string>;
  try {
    let transcript: string;
    try {
      transcript = await client.getTranscript(meeting.providerMeetingId);
    } catch (e) {
      if (e instanceof ReconnectRequiredError) throw e;
      throw new ProcessError("transcript", e instanceof Error ? e.name : "Error");
    }

    const open = await store.listItems(meeting.userId, { status: "open" });
    openIds = new Set(open.map((i) => i.id));
    if (!transcript.trim()) {
      result = { newItems: [], closes: [], usage: { inputTokens: 0, outputTokens: 0 } };
    } else {
      try {
        result = await deps.extract({
          transcript,
          user: { name: user.name, aliases: user.aliases, timeZone: user.timeZone },
          meeting: { title: meeting.title, startedAt: meeting.startedAt, participants: meeting.participants },
          openItems: open.map((i) => ({ id: i.id, kind: i.kind, text: i.text, person: i.person })),
        });
      } catch (e) {
        throw new ProcessError("extract", e instanceof Error ? e.name : "Error");
      }
    }
  } finally {
    if (!opts.client) await client.close?.();
  }

  const at = deps.now().toISOString();
  const newItems = result.newItems.map((n) => ({
    kind: n.kind,
    text: n.text,
    person: n.person,
    quote: clip(n.quote),
    meetingId: meeting.id,
    dueAt: n.dueAt,
  }));
  const seen = new Set<string>();
  const closes = result.closes
    .filter((c) => openIds.has(c.itemId) && !seen.has(c.itemId) && seen.add(c.itemId))
    .map((c) => ({ itemId: c.itemId, quote: clip(c.quote) }));

  try {
    await store.commitExtraction({ meetingId: meeting.id, userId: meeting.userId, newItems, closes, at });
  } catch (e) {
    throw new ProcessError("commit", e instanceof Error ? e.name : "Error");
  }

  const usage = result.usage;
  await store.logEvent({
    userId: meeting.userId,
    type: "extract_run",
    payload: { meetingId: meeting.id, model: deps.model, newItems: newItems.length, closes: closes.length, emptyTranscript: usage.inputTokens === 0 },
    tokensIn: usage.inputTokens,
    tokensOut: usage.outputTokens,
    costInr: usage.inputTokens || usage.outputTokens ? deps.costInr(deps.model, usage) : 0,
  });
  return { status: "processed", newItems: newItems.length, closes: closes.length };
}

/**
 * Process a user's unprocessed meetings oldest first (later meetings may close earlier items),
 * sharing one Wispr connection. One meeting's failure is logged and the rest continue; a
 * reconnect error stops this user. Stops starting new meetings after `deadline` (epoch ms).
 */
export async function processPending(
  deps: Pick<Deps, "store" | "wispr" | "extract" | "costInr" | "model" | "now">,
  userId: string,
  opts: { deadline?: number } = {},
): Promise<{ processed: number; failed: number; remaining: number }> {
  const pending = await deps.store.listUnprocessedMeetings(userId);
  let processed = 0;
  let failed = 0;
  if (pending.length === 0) return { processed, failed, remaining: 0 };
  const conn = await deps.store.getConnection(userId);
  if (!conn || conn.status === "needs_reconnect") return { processed, failed, remaining: pending.length };

  const client = deps.wispr(userId);
  try {
    for (const m of pending) {
      if (opts.deadline && Date.now() > opts.deadline) break;
      try {
        const r = await processMeeting(deps, m.id, { client });
        if (r.status === "processed") processed++;
      } catch (e) {
        failed++;
        if (e instanceof ReconnectRequiredError) break;
        await logJobError(deps, userId, "process", e, { meetingId: m.id }, { includeMessage: e instanceof ProcessError });
      }
    }
  } finally {
    await client.close?.();
  }
  return { processed, failed, remaining: pending.length - processed - failed };
}

export async function processAllPending(
  deps: Pick<Deps, "store" | "wispr" | "extract" | "costInr" | "model" | "now">,
  opts: { deadline?: number; concurrency?: number } = {},
) {
  const users = await deps.store.listUsers();
  return mapLimit(users, opts.concurrency ?? 2, async (u) => {
    try {
      return { userId: u.id, ...(await processPending(deps, u.id, opts)) };
    } catch (e) {
      await logJobError(deps, u.id, "process", e, {}, { includeMessage: false });
      return { userId: u.id, processed: 0, failed: 1, remaining: -1 };
    }
  });
}
