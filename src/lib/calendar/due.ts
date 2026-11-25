// Due-date sanity: "before the next standup" or no due at all, when there's a recurring meeting
// with that person, suggests the series' next occurrence as the due time. Pure.

import { belongsTo, groupNames } from "@/lib/people";
import type { CalendarEvent, Item, Meeting, MeetingSeries } from "@/lib/types";
import { nextOccurrence, normTitle, seriesPeople } from "./series";

export interface DueHint {
  itemId: string;
  /** Suggested due time, ISO UTC: the start of the series' next meeting. */
  dueAt: string;
  seriesId: string;
  seriesTitle: string;
  /** Why: the item names the series ("next standup"), or it's the next meeting with the person. */
  reason: "named" | "person";
}

/** Words after "next" that are dates, not meetings. */
const NOT_A_MEETING = /^(week|month|year|quarter|day|days|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|sprint|release|version|step|steps|one|few|couple)$/i;
const GENERIC_WORD = /^(meeting|meetings|sync|call|chat|catch-up|catchup|check-in|session|time)$/i;
const GENERIC = /\bnext\s+(?:meeting|time\s+we\s+(?:meet|talk|sync|speak)|sync|catch[\s-]?up|call|chat|check[\s-]?in)\b/i;

/**
 * What an item's words say about its due: a named series ("before the next standup",
 * "by our next 1:1"), the next meeting in general ("next time we meet"), or nothing.
 */
export function dueReference(text: string, series: MeetingSeries[]): { kind: "named"; series: MeetingSeries[] } | { kind: "generic" } | null {
  const re = /\bnext\s+([\p{L}\p{N}:'-]+)(?:\s+([\p{L}\p{N}:'-]+))?/giu;
  for (const m of text.matchAll(re)) {
    const w1 = m[1].toLowerCase().replace(/'s$/, "");
    if (NOT_A_MEETING.test(w1)) continue;
    if (GENERIC_WORD.test(w1)) continue; // "next sync", "next meeting": see GENERIC
    const w2 = m[2]?.toLowerCase();
    // "next standup", "next Nitin 1:1", "next design crit": the first word must be in the title
    const hits = series.filter((s) => titleHas(s.title, w1));
    if (hits.length) return { kind: "named", series: [...hits.filter((s) => !!w2 && titleHas(s.title, w2)), ...hits.filter((s) => !w2 || !titleHas(s.title, w2))] };
  }
  return GENERIC.test(text) ? { kind: "generic" } : null;
}

/** "Stand-up sync" has "standup", "stand-up" and "sync"; "Nitin 1:1" has "1:1". */
function titleHas(title: string, word: string): boolean {
  const w = word.replace(/[-']/g, "");
  const t = normTitle(title);
  return !!w && (t.split(" ").includes(w) || (w.length > 3 && t.replace(/ /g, "").includes(w)));
}

const HOUR = 3600_000;

/**
 * Due suggestions for open owe/waiting items. An item gets one when:
 *  - its text or quote names a series ("before the next standup"), and its due is empty or more
 *    than an hour off that series' next meeting; or
 *  - its due is empty (or it says "next time we meet") and a recurring series with its person
 *    exists: the smallest such series (1:1s first), then the soonest.
 * Only series with a next meeting on the cached calendar count.
 */
export function dueHints(args: {
  items: Item[];
  series: MeetingSeries[];
  meetings: Meeting[];
  events: CalendarEvent[];
  now: Date;
  self?: string[];
}): Map<string, DueHint> {
  const out = new Map<string, DueHint>();
  const self = args.self ?? [];
  const next = new Map(args.series.map((s) => [s.id, nextOccurrence(s, args.events, args.now)]));
  const scheduled = args.series.filter((s) => next.get(s.id));
  if (!scheduled.length) return out;
  const people = new Map(scheduled.map((s) => [s.id, seriesPeople(s, args.meetings, self)]));
  const open = args.items.filter((i) => i.status === "open" && (i.kind === "owe" || i.kind === "waiting"));
  const groups = groupNames([...open.map((i) => i.person ?? "").filter(Boolean), ...[...people.values()].flat()], self);

  const hint = (i: Item, s: MeetingSeries, reason: DueHint["reason"]): void => {
    const at = next.get(s.id)!.startsAt;
    if (i.dueAt && Math.abs(Date.parse(i.dueAt) - Date.parse(at)) <= HOUR) return; // already right
    out.set(i.id, { itemId: i.id, dueAt: at, seriesId: s.id, seriesTitle: s.title, reason });
  };

  for (const i of open) {
    const ref = dueReference(`${i.text} ${i.quote}`, scheduled);
    const g = i.person ? groups.find((x) => belongsTo(x, i.person)) : undefined;
    const withPerson = (s: MeetingSeries) => !!g && people.get(s.id)!.some((p) => belongsTo(g, p));
    if (ref?.kind === "named") { hint(i, ref.series.find(withPerson) ?? ref.series[0], "named"); continue; }
    if (i.dueAt && ref?.kind !== "generic") continue;
    if (!g) continue;
    const withThem = scheduled
      .filter(withPerson)
      .sort((a, b) => people.get(a.id)!.length - people.get(b.id)!.length || next.get(a.id)!.startsAt.localeCompare(next.get(b.id)!.startsAt));
    if (withThem[0]) hint(i, withThem[0], "person");
  }
  return out;
}
