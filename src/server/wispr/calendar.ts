// Calendar tools of the Wispr Flow MCP server: tool names, arguments and defensive parsing.
//
// Names and argument shapes were read from the tool schemas the Wispr Flow connector exposed to
// Claude on 2026-11-25:
//   search_calendar_events { since, until, query, attendee_emails, attendee_match, limit (max 200), cursor }
//   get_calendar_event     { calendar_id }
//   list_meeting_series    { meeting_id, limit (max 200), cursor } -> { recurring?, reason?, meetings[], has_more, next_cursor }
// Response field names were NOT checked against a live response: everything below parses
// several plausible spellings and skips rows it can't read. TODO: verify against the real server.

import { z } from "zod";
import type { CalendarEvent } from "@/lib/types";

export const CALENDAR_TOOLS = {
  searchEvents: {
    name: "search_calendar_events",
    args: (sinceIso: string, untilIso: string, cursor?: string) => ({ since: sinceIso, until: untilIso, limit: 200, ...(cursor ? { cursor } : {}) }),
  },
  getEvent: {
    name: "get_calendar_event",
    args: (calendarId: string) => ({ calendar_id: calendarId }),
  },
  listSeries: {
    name: "list_meeting_series",
    args: (meetingId: string, cursor?: string) => ({ meeting_id: meetingId, limit: 200, ...(cursor ? { cursor } : {}) }),
  },
  maxPages: 10,
} as const;

/** Calls one tool and returns its JSON payload (the client does the MCP unwrapping). */
export type CallPayload = (name: string, args: Record<string, unknown>) => Promise<unknown>;

const Id = z.union([z.string(), z.number()]).transform(String);
const When = z.union([
  z.string(),
  z.object({ dateTime: z.string().nullish(), date_time: z.string().nullish(), date: z.string().nullish() }).passthrough(),
]);

const EventSchema = z
  .object({
    calendar_id: Id.nullish(),
    event_id: Id.nullish(),
    id: Id.nullish(),
    title: z.string().nullish(),
    summary: z.string().nullish(),
    start: When.nullish(),
    start_time: z.string().nullish(),
    starts_at: z.string().nullish(),
    end: When.nullish(),
    end_time: z.string().nullish(),
    ends_at: z.string().nullish(),
    all_day: z.boolean().nullish(),
    is_all_day: z.boolean().nullish(),
    attendees: z.array(z.unknown()).nullish(),
    participants: z.array(z.unknown()).nullish(),
    attendee_preview: z.array(z.unknown()).nullish(),
    attendee_count: z.number().nullish(),
    recurring_event_id: Id.nullish(),
    recurringEventId: Id.nullish(),
    series_id: Id.nullish(),
    status: z.string().nullish(),
  })
  .passthrough();

const ListSchema = z
  .object({
    events: z.array(z.unknown()).optional(),
    results: z.array(z.unknown()).optional(),
    items: z.array(z.unknown()).optional(),
    meetings: z.array(z.unknown()).optional(),
    calendar_events: z.array(z.unknown()).optional(),
    has_more: z.boolean().nullish(),
    next_cursor: z.string().nullish(),
    recurring: z.boolean().nullish(),
    series_id: Id.nullish(),
    recurring_event_id: Id.nullish(),
  })
  .passthrough();

const Person = z.union([
  z.string(),
  z.object({ name: z.string().nullish(), display_name: z.string().nullish(), email: z.string().nullish(), self: z.boolean().nullish(), resource: z.boolean().nullish() }).passthrough(),
]);

function personName(a: unknown): string | null {
  const p = Person.safeParse(a);
  if (!p.success) return null;
  if (typeof p.data === "string") return p.data.trim() || null;
  if (p.data.resource) return null; // rooms
  return (p.data.name ?? p.data.display_name ?? p.data.email ?? "").trim() || null;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** A timed instant as ISO UTC; null for a date-only (all-day) value or junk. */
function instant(w: z.infer<typeof When> | null | undefined, ...alts: Array<string | null | undefined>): string | null {
  const s = typeof w === "string" ? w : w?.dateTime ?? w?.date_time ?? null;
  const raw = s ?? alts.find((x) => !!x) ?? null;
  if (!raw || DATE_ONLY.test(raw.trim())) return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export function parseEvent(raw: unknown): (CalendarEvent & { attendeeCount: number | null }) | null {
  const e = EventSchema.safeParse(raw);
  if (!e.success) return null;
  const d = e.data;
  if (d.all_day || d.is_all_day || d.status === "cancelled") return null;
  const id = d.calendar_id ?? d.event_id ?? d.id;
  const startsAt = instant(d.start, d.start_time, d.starts_at);
  if (!id || !startsAt) return null;
  let endsAt = instant(d.end, d.end_time, d.ends_at);
  if (endsAt && endsAt <= startsAt) endsAt = null;
  const people = (d.attendees ?? d.participants ?? d.attendee_preview ?? []).map(personName).filter((x): x is string => !!x);
  return {
    calendarId: id,
    title: (d.title ?? d.summary)?.trim() || "Untitled meeting",
    startsAt,
    endsAt,
    attendees: [...new Set(people)],
    recurringId: d.recurring_event_id ?? d.recurringEventId ?? d.series_id ?? null,
    attendeeCount: d.attendee_count ?? null,
  };
}

export function parseEventList(payload: unknown): { events: Array<CalendarEvent & { attendeeCount: number | null }>; next: string | null } {
  const r = ListSchema.safeParse(payload);
  if (!r.success) return { events: [], next: null };
  const list = r.data.events ?? r.data.calendar_events ?? r.data.results ?? r.data.items ?? r.data.meetings ?? [];
  const events = list.map(parseEvent).filter((x): x is NonNullable<typeof x> => !!x);
  return { events, next: r.data.has_more && r.data.next_cursor ? r.data.next_cursor : null };
}

/**
 * Every timed event starting in [sinceIso, untilIso), soonest first. Pages until has_more is false.
 * Events whose preview holds fewer attendees than attendee_count are re-read with
 * get_calendar_event (at most `fullLimit` of them) so the attendee list is complete.
 */
export async function searchCalendarEvents(call: CallPayload, sinceIso: string, untilIso: string, fullLimit = 15): Promise<CalendarEvent[]> {
  const t = CALENDAR_TOOLS.searchEvents;
  const seen = new Map<string, CalendarEvent & { attendeeCount: number | null }>();
  let cursor: string | undefined;
  for (let page = 0; page < CALENDAR_TOOLS.maxPages; page++) {
    const { events, next } = parseEventList(await call(t.name, t.args(sinceIso, untilIso, cursor)));
    for (const e of events) if (e.startsAt >= sinceIso && e.startsAt < untilIso) seen.set(`${e.calendarId}@${e.startsAt}`, e);
    if (!next || next === cursor) break;
    cursor = next;
  }
  const list = [...seen.values()].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  let full = 0;
  for (const e of list) {
    if (full >= fullLimit || e.attendeeCount === null || e.attendeeCount <= e.attendees.length) continue;
    full++;
    try {
      const raw = await call(CALENDAR_TOOLS.getEvent.name, CALENDAR_TOOLS.getEvent.args(e.calendarId));
      const obj = raw && typeof raw === "object" && "event" in raw ? (raw as { event: unknown }).event : raw;
      const got = parseEvent(obj);
      if (got && got.attendees.length > e.attendees.length) e.attendees = got.attendees;
    } catch {
      // keep the preview
    }
  }
  return list.map((e) => ({ calendarId: e.calendarId, title: e.title, startsAt: e.startsAt, endsAt: e.endsAt, attendees: e.attendees, recurringId: e.recurringId }));
}

export interface SeriesOccurrence { providerMeetingId: string; title: string; startedAt: string | null }

const OccurrenceSchema = z
  .object({ id: Id.nullish(), meeting_id: Id.nullish(), title: z.string().nullish(), start: z.string().nullish(), start_time: z.string().nullish(), started_at: z.string().nullish(), created_at: z.string().nullish() })
  .passthrough();

/**
 * Every recorded occurrence of the recurring series `meetingId` belongs to, or null when the
 * meeting is not recurring. The occurrence list always includes the meeting passed in.
 */
export async function listMeetingSeries(call: CallPayload, meetingId: string): Promise<{ occurrences: SeriesOccurrence[]; recurringId: string | null } | null> {
  const t = CALENDAR_TOOLS.listSeries;
  const out = new Map<string, SeriesOccurrence>();
  let recurringId: string | null = null;
  let cursor: string | undefined;
  for (let page = 0; page < CALENDAR_TOOLS.maxPages; page++) {
    const r = ListSchema.safeParse(await call(t.name, t.args(meetingId, cursor)));
    if (!r.success) break;
    if (r.data.recurring === false) return null;
    recurringId ??= r.data.series_id ?? r.data.recurring_event_id ?? null;
    for (const raw of r.data.meetings ?? r.data.results ?? r.data.items ?? []) {
      const o = OccurrenceSchema.safeParse(raw);
      const id = o.success ? o.data.id ?? o.data.meeting_id : null;
      if (!o.success || !id) continue;
      const when = o.data.start ?? o.data.start_time ?? o.data.started_at ?? o.data.created_at ?? null;
      const ms = when ? Date.parse(when) : NaN;
      out.set(id, { providerMeetingId: id, title: o.data.title?.trim() || "Untitled meeting", startedAt: Number.isNaN(ms) ? null : new Date(ms).toISOString() });
    }
    const next = r.data.has_more && r.data.next_cursor ? r.data.next_cursor : null;
    if (!next || next === cursor) break;
    cursor = next;
  }
  // A series of one recorded meeting is still a series (the next one is on the calendar).
  if (!out.size) return null;
  if (!out.has(meetingId)) out.set(meetingId, { providerMeetingId: meetingId, title: "Untitled meeting", startedAt: null });
  return { occurrences: [...out.values()], recurringId };
}
