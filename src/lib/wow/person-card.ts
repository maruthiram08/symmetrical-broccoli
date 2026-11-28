// Person hover card and "who's waiting on you". Pure; reuses People's name matching.

import { belongsTo, findPerson, groupNames, ownsItem, type PeopleInput } from "@/lib/people";
import type { Item, Meeting } from "@/lib/types";

export interface PersonCardItem {
  id: string;
  text: string;
  late: boolean;
}

export interface PersonCard {
  name: string;
  slug: string;
  /** Open things you owe them, oldest first (at most `max`). */
  youOwe: PersonCardItem[];
  youOweCount: number;
  /** Open things they owe you, oldest first (at most `max`). */
  theyOwe: PersonCardItem[];
  theyOweCount: number;
  /** The latest meeting they were in, or null. */
  lastMeeting: { id: string; title: string; startedAt: string } | null;
}

const live = (i: Item) => i.status !== "wrong";

/** Everything the hover card shows for one person, or null when no item names them. */
export function personCard(slug: string, input: PeopleInput, max = 3): PersonCard | null {
  const g = findPerson(slug, input);
  if (!g) return null;
  const { items, meetings, now } = input;
  const byId = new Map(meetings.map((m) => [m.id, m]));
  const started = (i: Item) => byId.get(i.meetingId)?.startedAt ?? i.createdAt;
  const mine = items.filter((i) => live(i) && ownsItem(g, i));
  const open = mine.filter((i) => i.status === "open").sort((a, b) => started(a).localeCompare(started(b)));
  const card = (i: Item): PersonCardItem => ({ id: i.id, text: i.text, late: !!i.dueAt && Date.parse(i.dueAt) < now.getTime() });
  const owe = open.filter((i) => i.kind === "owe");
  const theirs = open.filter((i) => i.kind === "waiting");
  const ids = new Set(mine.map((i) => i.meetingId));
  const last = meetings
    .filter((m) => ids.has(m.id) || m.participants.some((p) => belongsTo(g, p)))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  return {
    name: g.name,
    slug: g.slug,
    youOwe: owe.slice(0, max).map(card),
    youOweCount: owe.length,
    theyOwe: theirs.slice(0, max).map(card),
    theyOweCount: theirs.length,
    lastMeeting: last ? { id: last.id, title: last.title, startedAt: last.startedAt } : null,
  };
}

export interface WaitingOnYou {
  name: string;
  slug: string;
  count: number;
  /** Whole days since the oldest open promise to them was made. */
  oldestDays: number;
}

/**
 * People you owe the most (then the longest), for the line on Today. Only open "owe" items with a
 * person count; the user's own names are left out.
 */
export function waitingOnYou(input: PeopleInput & { meetings: Meeting[] }, max = 3): WaitingOnYou[] {
  const { items, meetings, now, self = [], people = [] } = input;
  const owe = items.filter((i) => i.status === "open" && i.kind === "owe" && i.person);
  if (!owe.length) return [];
  const byId = new Map(meetings.map((m) => [m.id, m]));
  const started = (i: Item) => Date.parse(byId.get(i.meetingId)?.startedAt ?? i.createdAt);
  // Group over every live item so the name and link match the People page.
  return groupNames(items.filter((i) => live(i) && i.person).map((i) => i.person!), self, people)
    .map((g) => {
      const theirs = owe.filter((i) => ownsItem(g, i));
      const oldest = Math.min(...theirs.map(started));
      return { name: g.name, slug: g.slug, count: theirs.length, oldestDays: Math.max(0, Math.floor((now.getTime() - oldest) / 86400000)) };
    })
    .filter((p) => p.count > 0)
    .sort((a, b) => b.count - a.count || b.oldestDays - a.oldestDays || a.name.localeCompare(b.name))
    .slice(0, max);
}

/** "Nitin is waiting on 3 things, oldest 6 days" */
export function waitingPhrase(p: WaitingOnYou): string {
  const things = p.count === 1 ? "1 thing" : `${p.count} things`;
  const days = p.oldestDays === 1 ? "1 day" : `${p.oldestDays} days`;
  const age = p.oldestDays === 0 ? (p.count === 1 ? "from today" : "all from today") : p.count === 1 ? `${days} old` : `oldest ${days}`;
  return `${p.name} is waiting on ${things}, ${age}`;
}
