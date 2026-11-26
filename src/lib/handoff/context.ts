// Builds a HandoffContext from stored rows. Pure: the caller does the reads.
import type { Item, Meeting, User } from "../types";
import type { HandoffContext } from "./types";
import { itemsSamePerson } from "../people";

export const RELATED_MAX = 5;

/** Same person when the names match ignoring case, or one is the other's first name. */
export function samePerson(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (!x || !y) return false;
  if (x === y) return true;
  const fx = x.split(/\s+/)[0];
  const fy = y.split(/\s+/)[0];
  return (fx === y || fy === x) && fx === fy;
}

export function buildContext(args: {
  item: Item;
  user: Pick<User, "name" | "timeZone">;
  meetings: Map<string, Pick<Meeting, "title" | "startedAt"> | null>;
  allItems: Item[];
  now: Date;
}): HandoffContext | null {
  const { item, user, meetings, allItems, now } = args;
  if (item.kind === "decision") return null;
  const m = meetings.get(item.meetingId) ?? null;
  const related = allItems
    .filter((i) => i.id !== item.id && i.status !== "wrong" && i.kind !== "decision" && itemsSamePerson(i, item, samePerson))
    .sort((a, b) => (b.status === "open" ? 1 : 0) - (a.status === "open" ? 1 : 0) || b.createdAt.localeCompare(a.createdAt))
    .slice(0, RELATED_MAX)
    .map((i) => ({ kind: i.kind, text: i.text, status: i.status, meetingTitle: meetings.get(i.meetingId)?.title ?? null }));
  return {
    user: { name: user.name, timeZone: user.timeZone },
    item: { id: item.id, kind: item.kind, text: item.text, person: item.person, quote: item.quote, dueAt: item.dueAt },
    meeting: m ? { title: m.title, startedAt: m.startedAt } : null,
    related,
    now: now.toISOString(),
  };
}
