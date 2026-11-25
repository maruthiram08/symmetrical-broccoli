import type { ClosedLine, LastLook } from "@/lib/types";
import { meetingIndex, shortDay, type BriefData } from "./data";
import { formatTime, localDate } from "./time";

/** Looks closer together than this are one look: a refresh or an auto-refresh keeps the close moment. */
export const LOOK_SESSION_MINUTES = 30;

export interface Look {
  /** Show closes after this instant. Null on the first look ever: nothing to compare with yet. */
  since: string | null;
  /** Closes after this instant are new since the last render, and get the one-time highlight. */
  freshAfter: string | null;
  /** What to store for next time. */
  next: LastLook;
}

/** Work out this look from the stored one. Pure. */
export function nextLook(prev: LastLook | null, now: Date): Look {
  const nowIso = now.toISOString();
  if (!prev) return { since: null, freshAfter: null, next: { lastLookedAt: nowIso, since: null } };
  const sameLook = now.getTime() - Date.parse(prev.lastLookedAt) < LOOK_SESSION_MINUTES * 60_000;
  const since = sameLook ? prev.since : prev.lastLookedAt;
  return { since, freshAfter: prev.lastLookedAt, next: { lastLookedAt: nowIso, since } };
}

export interface CloseMomentLine extends ClosedLine {
  closedAt: string;
  /** Closed since the previous render: highlight once. */
  fresh: boolean;
}

/** Items a later meeting closed after `look.since`, newest first. Pure. */
export function closedSince(data: BriefData, look: Pick<Look, "since" | "freshAfter">, now: Date, timeZone: string): CloseMomentLine[] {
  if (!look.since) return [];
  const since = look.since;
  const meeting = meetingIndex(data.meetings);
  const today = localDate(now, timeZone);
  const nowIso = now.toISOString();
  return data.items
    .filter((i) => i.status === "done" && i.closedByMeetingId && i.closeQuote && i.closedAt && i.closedAt > since && i.closedAt <= nowIso)
    .sort((a, b) => b.closedAt!.localeCompare(a.closedAt!))
    .map((i) => {
      const m = meeting(i.closedByMeetingId);
      const otherDay = m && localDate(new Date(m.startedAt), timeZone) !== today;
      return {
        itemId: i.id,
        text: i.text,
        closeQuote: i.closeQuote!,
        person: i.kind === "waiting" ? i.person : null,
        closedInMeeting: m?.title ?? "a meeting",
        closedAtTime: m ? `${otherDay ? `${shortDay(m.startedAt, timeZone)}, ` : ""}${formatTime(m.startedAt, timeZone)}` : "",
        closedAt: i.closedAt!,
        fresh: !!look.freshAfter && i.closedAt! > look.freshAfter,
      };
    });
}
