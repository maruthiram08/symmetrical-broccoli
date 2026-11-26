import { AnthropicCallError, isNetworkError } from "@/lib/extract/errors";
import { keepSharedItems, sharedMeetingConcernsUser } from "@/lib/extract/shared";
import { knownPeople } from "@/lib/directory/directory";
import { MAX_MEETING_ATTEMPTS, QUOTE_MAX, type ExtractionResult, type Item, type Meeting } from "@/lib/types";
import type { WisprClient } from "@/server/wispr/client";
import { ReconnectRequiredError } from "@/server/wispr/oauth";
import { logJobError, mapLimit, type Deps } from "./types";

export type ProcessResult =
  | { status: "processed"; newItems: number; closes: number }
  | { status: "skipped"; reason: "not_found" | "already_processed" | "no_user" };

/**
 * Why a read failed, which decides what happens next:
 *  - auth / credit: the Anthropic key or account. Stop reading, show a banner, don't count it.
 *  - offline: no network. Stop reading, try again on the next poll, don't count it.
 *  - transient: Anthropic overloaded or rate limited even after retries. Count it and stop for now.
 *  - anything else (bad model output, a 4xx, a transcript error): count it and go on with the next.
 */
export type FailureKind = "auth" | "credit" | "offline" | "transient" | "bad_request" | "bad_output" | "transcript" | "extract" | "commit";

/**
 * Error raised by processMeeting. It carries only a stage, a kind and the original error's name,
 * never its message, because messages from the transcript fetch or the model call may echo transcript text.
 */
export class ProcessError extends Error {
  constructor(public stage: "transcript" | "extract" | "commit", public causeName: string, public kind: FailureKind = stage) {
    super(`processing failed at ${stage} (${causeName}${kind !== stage ? `, ${kind}` : ""})`);
    this.name = "ProcessError";
  }
}

function extractFailure(e: unknown): FailureKind {
  if (e instanceof AnthropicCallError) return e.kind;
  if (e instanceof Error && e.name === "ExtractionError") return "bad_output";
  return "extract";
}

/** A meeting that failed is tried again after 10, 20, 40... minutes, so a manual check doesn't hammer it. */
export function retryAfterMs(attempts: number): number {
  return attempts > 0 ? 10 * 60_000 * 2 ** (attempts - 1) : 0;
}

/** Set aside after too many failed reads: shown as "couldn't be read" with a Retry button. */
export function isSetAside(m: Pick<Meeting, "failedAttempts">): boolean {
  return (m.failedAttempts ?? 0) >= MAX_MEETING_ATTEMPTS;
}

const clip = (s: string) => (s.length > QUOTE_MAX ? s.slice(0, QUOTE_MAX - 1) + "…" : s);

/**
 * Extract items from one meeting and commit them atomically. Idempotent: an already-processed
 * meeting is skipped. The transcript lives only in this function's scope: it is never stored,
 * logged or attached to an error.
 */
/** Meetings being processed right now in this process, so overlapping runs never read one twice. */
const inFlight: Set<string> = ((globalThis as unknown as { __dbInFlight?: Set<string> }).__dbInFlight ??= new Set<string>());

export async function processMeeting(
  deps: Pick<Deps, "store" | "wispr" | "extract" | "costInr" | "model" | "now">,
  meetingId: string,
  opts: { client?: WisprClient } = {},
): Promise<ProcessResult> {
  if (inFlight.has(meetingId)) return { status: "skipped", reason: "already_processed" };
  inFlight.add(meetingId);
  try {
    return await processMeetingOnce(deps, meetingId, opts);
  } finally {
    inFlight.delete(meetingId);
  }
}

async function processMeetingOnce(
  deps: Pick<Deps, "store" | "wispr" | "extract" | "costInr" | "model" | "now">,
  meetingId: string,
  opts: { client?: WisprClient },
): Promise<ProcessResult> {
  const { store } = deps;
  const meeting = await store.getMeeting(meetingId);
  if (!meeting) return { status: "skipped", reason: "not_found" };
  if (meeting.processedAt) return { status: "skipped", reason: "already_processed" };
  const user = await store.getUser(meeting.userId);
  if (!user) return { status: "skipped", reason: "no_user" };

  let result: ExtractionResult;
  let openIds: Set<string> = new Set();
  const nothing = (): ExtractionResult => ({ newItems: [], closes: [], usage: { inputTokens: 0, outputTokens: 0 } });
  if (meeting.shared && user.includeShared !== true) {
    // Queued while "Include shared meetings" was on, then turned off: close it out without a read.
    await store.commitExtraction({ meetingId: meeting.id, userId: meeting.userId, newItems: [], closes: [], at: deps.now().toISOString() });
    return { status: "processed", newItems: 0, closes: 0 };
  }

  const client = opts.client ?? deps.wispr(meeting.userId);
  try {
    let transcript: string;
    try {
      transcript = await client.getTranscript(meeting.providerMeetingId);
    } catch (e) {
      if (e instanceof ReconnectRequiredError) throw e;
      throw new ProcessError("transcript", e instanceof Error ? e.name : "Error", isNetworkError(e) ? "offline" : "transcript");
    }

    // Only promises made before this meeting can be closed by it, and decisions are never "open work".
    const startOf = new Map<string, string>();
    const open: Item[] = [];
    for (const i of await store.listItems(meeting.userId, { status: "open" })) {
      if (i.kind === "decision") continue;
      if (!startOf.has(i.meetingId)) startOf.set(i.meetingId, (await store.getMeeting(i.meetingId))?.startedAt ?? "");
      if (startOf.get(i.meetingId)! < meeting.startedAt) open.push(i);
    }
    openIds = new Set(open.map((i) => i.id));
    if (!transcript.trim()) {
      result = nothing();
    } else if (meeting.shared && !sharedMeetingConcernsUser(transcript, user)) {
      // Someone else's meeting where you neither speak nor are named: nothing could reach your brief.
      result = nothing();
    } else {
      const known = knownPeople(await store.getPeople?.(meeting.userId));
      try {
        result = await deps.extract({
          transcript,
          user: { name: user.name, aliases: user.aliases, timeZone: user.timeZone },
          meeting: {
            title: meeting.title, startedAt: meeting.startedAt, participants: meeting.participants,
            ...(meeting.shared ? { shared: true, ownerName: meeting.ownerName ?? null } : {}),
          },
          openItems: open.map((i) => ({ id: i.id, kind: i.kind, text: i.text, person: i.person })),
          ...(known.length ? { knownPeople: known } : {}),
        });
      } catch (e) {
        throw new ProcessError("extract", e instanceof Error ? e.name : "Error", extractFailure(e));
      }
      if (meeting.shared) result = { ...result, newItems: keepSharedItems(result.newItems, transcript, user) };
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
    payload: { meetingId: meeting.id, model: deps.model, newItems: newItems.length, closes: closes.length, emptyTranscript: usage.inputTokens === 0, ...(meeting.shared ? { shared: true } : {}) },
    tokensIn: usage.inputTokens,
    tokensOut: usage.outputTokens,
    costInr: usage.inputTokens || usage.outputTokens ? deps.costInr(deps.model, usage) : 0,
  });
  // A good model call proves the key and the credit are fine again.
  await store.setHealth?.({ lastExtractOkAt: at, ...(usage.inputTokens ? { anthropicProblem: null } : {}) });
  return { status: "processed", newItems: newItems.length, closes: closes.length };
}

/**
 * Process a user's unprocessed meetings oldest first (later meetings may close earlier items),
 * sharing one Wispr connection. One meeting's failure is logged and counted and the rest continue.
 * A reconnect error, an Anthropic key/credit problem, being offline or Anthropic being overloaded
 * stops this user until the next run (no point hammering). A meeting that failed recently waits
 * (retryAfterMs), and one that failed MAX_MEETING_ATTEMPTS times is set aside until Retry.
 * A failed meeting is never marked processed. Stops starting new meetings after `deadline` (epoch ms).
 */
export async function processPending(
  deps: Pick<Deps, "store" | "wispr" | "extract" | "costInr" | "model" | "now">,
  userId: string,
  opts: { deadline?: number } = {},
): Promise<{ processed: number; failed: number; remaining: number; setAside: number; stoppedBy?: FailureKind | "reconnect" }> {
  const all = await deps.store.listUnprocessedMeetings(userId);
  const setAside = all.filter(isSetAside).length;
  const pending = all.filter((m) => !isSetAside(m));
  let processed = 0;
  let failed = 0;
  let stoppedBy: FailureKind | "reconnect" | undefined;
  if (pending.length === 0) return { processed, failed, remaining: 0, setAside };
  const conn = await deps.store.getConnection(userId);
  if (!conn || conn.status === "needs_reconnect") return { processed, failed, remaining: pending.length, setAside, stoppedBy: "reconnect" };

  const nowMs = deps.now().getTime();
  const client = deps.wispr(userId);
  try {
    for (const m of pending) {
      if (opts.deadline && Date.now() > opts.deadline) break;
      if (m.lastFailedAt && nowMs - Date.parse(m.lastFailedAt) < retryAfterMs(m.failedAttempts ?? 0)) continue;
      try {
        const r = await processMeeting(deps, m.id, { client });
        if (r.status === "processed") processed++;
      } catch (e) {
        failed++;
        if (e instanceof ReconnectRequiredError) { stoppedBy = "reconnect"; break; }
        const kind: FailureKind = e instanceof ProcessError ? e.kind : "extract";
        await logJobError(deps, userId, "process", e, { meetingId: m.id, kind }, { includeMessage: e instanceof ProcessError });
        if (kind === "auth" || kind === "credit") {
          await deps.store.setHealth?.({ anthropicProblem: { kind, at: deps.now().toISOString() } });
          stoppedBy = kind;
          break;
        }
        if (kind === "offline") { stoppedBy = kind; break; }
        await deps.store.recordMeetingFailure?.(m.id, kind, deps.now().toISOString());
        if (kind === "transient") { stoppedBy = kind; break; }
      }
    }
  } finally {
    await client.close?.();
  }
  const nowSetAside = (await deps.store.listUnprocessedMeetings(userId)).filter(isSetAside).length;
  return { processed, failed, remaining: pending.length - processed - failed, setAside: nowSetAside, ...(stoppedBy ? { stoppedBy } : {}) };
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
      return { userId: u.id, processed: 0, failed: 1, remaining: -1, setAside: 0 };
    }
  });
}
