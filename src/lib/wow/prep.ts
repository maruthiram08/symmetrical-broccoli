// Prep card: what's open with the people in your next meeting. Pure.

import { belongsTo, groupNames, normalizeName } from "@/lib/people";
import type { Item, UpcomingMeeting } from "@/lib/types";

export interface Prep {
  meeting: UpcomingMeeting;
  /** Attendees other than you, as Wispr Flow wrote them (emails turned into names). */
  people: string[];
  owe: Item[];
  waiting: Item[];
}

/** "nitin.kumar@acme.com" -> "Nitin Kumar"; names pass through. */
export function attendeeName(raw: string): string {
  const s = raw.trim();
  if (!s.includes("@")) return s;
  return s.split("@")[0].replace(/[._+-]+/g, " ").trim().replace(/\b\p{Ll}/gu, (c) => c.toUpperCase());
}

/** The next meeting that starts after `now` and within `windowMin` minutes, or null. */
export function nextUpcoming(meetings: UpcomingMeeting[], now: Date, windowMin = 60): UpcomingMeeting | null {
  const t = now.getTime();
  return [...meetings]
    .filter((m) => { const s = Date.parse(m.startsAt); return s > t && s <= t + windowMin * 60_000; })
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0] ?? null;
}

/**
 * Open owe and waiting items whose person is one of the meeting's attendees. Uses the People
 * feature's grouping, so "Nitin" on an item matches "Nitin Kumar" in the invite (and
 * "nitin.kumar@acme.com"), but "Nitin Rao" does not match "Nitin Kumar".
 */
export function prepFor(meeting: UpcomingMeeting, items: Item[], self: string[] = []): Prep {
  const selfKeys = new Set(self.map(normalizeName).filter(Boolean));
  const people = meeting.attendees.map(attendeeName).filter((a) => a && !selfKeys.has(normalizeName(a)));
  const open = items.filter((i) => i.status === "open" && i.kind !== "decision" && i.person);
  const groups = groupNames([...open.map((i) => i.person!), ...people], self);
  const theirs = groups.filter((g) => people.some((p) => belongsTo(g, p)));
  const matches = (i: Item) => theirs.some((g) => belongsTo(g, i.person));
  const byDue = (a: Item, b: Item) => (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999") || a.createdAt.localeCompare(b.createdAt);
  return {
    meeting,
    people: [...new Set(people)],
    owe: open.filter((i) => i.kind === "owe" && matches(i)).sort(byDue),
    waiting: open.filter((i) => i.kind === "waiting" && matches(i)).sort(byDue),
  };
}

/** Notification text: "With Nitin, Priya: 2 you owe, 1 waiting". */
export function prepNotice(p: Prep): string {
  const who = p.people.length ? `With ${p.people.slice(0, 3).join(", ")}${p.people.length > 3 ? ` +${p.people.length - 3}` : ""}` : "Coming up";
  const parts = [p.owe.length ? `${p.owe.length} you owe` : "", p.waiting.length ? `${p.waiting.length} waiting` : ""].filter(Boolean);
  return parts.length ? `${who}: ${parts.join(", ")}` : `${who}: nothing open`;
}
