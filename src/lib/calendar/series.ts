// Recurring meeting series and the cached calendar. Pure.

import { normalizeName } from "@/lib/people";
import { attendeeName } from "@/lib/wow/prep";
import type { CalendarCache, CalendarEvent, Item, Meeting, MeetingSeries } from "@/lib/types";

/** Cached events older than this are not shown (the poll may have stopped). */
export const CALENDAR_MAX_STALE_MS = 24 * 60 * 60 * 1000;

/** The cached events, or [] when there is no cache or it is more than a day old. */
export function freshEvents(cache: CalendarCache | null, now: Date): CalendarEvent[] {
  if (!cache?.fetchedAt) return [];
  if (now.getTime() - Date.parse(cache.fetchedAt) > CALENDAR_MAX_STALE_MS) return [];
  return cache.events;
}

/** Short stable id from a string (FNV-1a, base 36). */
export function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(7, "0");
}

export const normTitle = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}:]+/gu, " ").trim();

/**
 * Add one list_meeting_series answer to the known series. Occurrences that already belong to a
 * series join it (and series it bridges are merged), else a new series starts. Returns the series id.
 */
export function mergeSeries(
  series: MeetingSeries[],
  found: { occurrences: Array<{ providerMeetingId: string; title: string; startedAt: string | null }>; recurringId: string | null },
): { series: MeetingSeries[]; id: string } {
  const ids = new Set(found.occurrences.map((o) => o.providerMeetingId));
  const touching = series.filter((s) => s.providerMeetingIds.some((p) => ids.has(p)) || (!!found.recurringId && s.recurringId === found.recurringId));
  const rest = series.filter((s) => !touching.includes(s));
  const newest = [...found.occurrences].sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""))[0];
  const all = [...new Set([...touching.flatMap((s) => s.providerMeetingIds), ...ids])].sort();
  const id = touching[0]?.id ?? shortHash(found.recurringId ?? all[0]);
  const merged: MeetingSeries = {
    id,
    title: newest?.title && newest.title !== "Untitled meeting" ? newest.title : touching[0]?.title ?? "Untitled meeting",
    providerMeetingIds: all,
    recurringId: found.recurringId ?? touching.find((s) => s.recurringId)?.recurringId ?? null,
  };
  return { series: [...rest, merged], id };
}

/** Recorded meetings of a series that are in the store, newest first. */
export function seriesMeetings(s: MeetingSeries, meetings: Meeting[]): Meeting[] {
  const ids = new Set(s.providerMeetingIds);
  return meetings.filter((m) => ids.has(m.providerMeetingId)).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** Does a calendar event belong to this series? By recurring id when both have one, else by title. */
export function eventInSeries(e: CalendarEvent, s: MeetingSeries): boolean {
  if (e.recurringId && s.recurringId) return e.recurringId === s.recurringId;
  return normTitle(e.title) === normTitle(s.title);
}

/** The series' next event starting after `now`, from the cached calendar. */
export function nextOccurrence(s: MeetingSeries, events: CalendarEvent[], now: Date): CalendarEvent | null {
  const t = now.getTime();
  return events.filter((e) => Date.parse(e.startsAt) > t && eventInSeries(e, s)).sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0] ?? null;
}

/** The series an event belongs to, if any. */
export function seriesOfEvent(e: CalendarEvent, series: MeetingSeries[]): MeetingSeries | null {
  return series.find((s) => eventInSeries(e, s)) ?? null;
}

/** Everyone who was in the series' recorded meetings, minus you, as written in the newest one. */
export function seriesPeople(s: MeetingSeries, meetings: Meeting[], self: string[] = []): string[] {
  const selfKeys = new Set(self.map(normalizeName).filter(Boolean));
  const seen = new Map<string, string>();
  for (const m of seriesMeetings(s, meetings)) {
    for (const raw of m.participants) {
      const n = attendeeName(raw);
      const k = normalizeName(n);
      if (k && !selfKeys.has(k) && !seen.has(k)) seen.set(k, n);
    }
  }
  return [...seen.values()];
}

export interface SeriesDetail {
  series: MeetingSeries;
  people: string[];
  next: CalendarEvent | null;
  /** Recorded meetings newest first, each with its promises and decisions (minus ones marked Wrong). */
  meetings: Array<{ meeting: Meeting; items: Item[] }>;
  counts: { open: number; done: number; decisions: number };
}

const KIND_ORDER: Record<Item["kind"], number> = { owe: 0, waiting: 1, decision: 2 };

/** Everything for /series/[id]. */
export function seriesDetail(s: MeetingSeries, args: { meetings: Meeting[]; items: Item[]; events: CalendarEvent[]; now: Date; self?: string[] }): SeriesDetail {
  const ms = seriesMeetings(s, args.meetings);
  const ids = new Set(ms.map((m) => m.id));
  const items = args.items.filter((i) => ids.has(i.meetingId) && i.status !== "wrong");
  return {
    series: s,
    people: seriesPeople(s, args.meetings, args.self),
    next: nextOccurrence(s, args.events, args.now),
    meetings: ms.map((m) => ({
      meeting: m,
      items: items.filter((i) => i.meetingId === m.id).sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.createdAt.localeCompare(b.createdAt)),
    })),
    counts: {
      open: items.filter((i) => i.kind !== "decision" && i.status === "open").length,
      done: items.filter((i) => i.kind !== "decision" && i.status === "done").length,
      decisions: items.filter((i) => i.kind === "decision").length,
    },
  };
}
