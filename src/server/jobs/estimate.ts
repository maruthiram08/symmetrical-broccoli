import { COST_PER_MEETING_INR } from "@/lib/extract/cost";
import { WISPR_TOOLS } from "@/server/wispr/client";
import type { Deps } from "./types";

export interface ReadEstimate {
  /** Meetings Wispr Flow has from `since` on (own, plus shared ones when asked). */
  found: number;
  /** Of those, meetings shared with the user. */
  shared: number;
  /** Meetings that would be read now: finished, with a transcript, not read before. */
  toRead: number;
  /** toRead × the average cost of one read, rounded to the rupee. */
  costInr: number;
}

/**
 * Before a first read or a pull: how many meetings it would read and roughly what that costs.
 * One search_meetings listing, no transcripts, no AI. Throws when Wispr Flow can't be reached.
 */
export async function estimateRead(
  deps: Pick<Deps, "store" | "wispr" | "now">,
  userId: string,
  sinceIso: string,
  opts: { includeShared?: boolean } = {},
): Promise<ReadEstimate> {
  const client = deps.wispr(userId);
  let meetings;
  try {
    meetings = await client.listMeetingsSince(sinceIso, { includeShared: opts.includeShared === true });
  } finally {
    await client.close?.();
  }
  const now = deps.now().getTime();
  const known = new Map(
    (await deps.store.listMeetingsBetween(userId, sinceIso, "9999")).map((m) => [m.providerMeetingId, m.processedAt !== null]),
  );
  const toRead = meetings.filter((m) => {
    const ready = m.finalized || now - Date.parse(m.startedAt) > WISPR_TOOLS.unfinalizedGiveUpMs;
    return ready && m.hasTranscript && known.get(m.providerMeetingId) !== true;
  }).length;
  return {
    found: meetings.length,
    shared: meetings.filter((m) => m.shared).length,
    toRead,
    costInr: Math.round(toRead * COST_PER_MEETING_INR),
  };
}
