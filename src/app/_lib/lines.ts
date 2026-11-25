import { peekInfo } from "@/lib/brief/build";
import { dueLabel, formatTime, lateLabel } from "@/lib/brief/time";
import type { BriefLine, ClosedLine, Item, Meeting, User } from "@/lib/types";
import { getStore } from "@/server/local/app";
import { lineExtras } from "@/lib/capture/items";

/** Everything one user has: items (all statuses) and meetings. Read straight from the local store. */
export async function loadAll(user: User): Promise<{ items: Item[]; meetings: Meeting[] }> {
  const store = getStore();
  const [items, meetings] = await Promise.all([store.listItems(user.id), store.listMeetingsBetween(user.id, "0000", "9999")]);
  return { items, meetings };
}

/** "25 Nov" in the user's zone. */
export function shortDate(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone });
}

/** An item as a BriefLine, the meeting named with its date (as on All open). */
export function toLine(i: Item, meetings: Map<string, Meeting>, user: User, now: Date): BriefLine {
  const m = meetings.get(i.meetingId);
  const late = i.kind !== "decision" && i.dueAt && Date.parse(i.dueAt) < now.getTime() ? Math.floor((now.getTime() - Date.parse(i.dueAt)) / 60000) : null;
  return {
    itemId: i.id, kind: i.kind, text: i.text, person: i.person, quote: i.quote,
    meetingTitle: m ? `${m.title}, ${shortDate(m.startedAt, user.timeZone)}` : "a meeting",
    meetingTime: m ? formatTime(m.startedAt, user.timeZone) : "",
    dueLabel: i.dueAt && late === null && i.kind !== "decision" ? dueLabel(i.dueAt, now, user.timeZone) : null,
    lateMinutes: late, lateLabel: late !== null ? lateLabel(late) : null,
    meetingId: i.meetingId, peek: peekInfo(i, m ?? null, user.timeZone),
    ...lineExtras(i),
  };
}

export function toClosedLine(i: Item, meetings: Map<string, Meeting>, user: User): ClosedLine {
  const m = i.closedByMeetingId ? meetings.get(i.closedByMeetingId) : undefined;
  return {
    itemId: i.id, text: i.text, closeQuote: i.closeQuote ?? "",
    person: i.kind === "waiting" ? i.person : null,
    closedInMeeting: m ? m.title : "a meeting",
    closedAtTime: i.closedAt ? shortDate(i.closedAt, user.timeZone) : "",
  };
}
