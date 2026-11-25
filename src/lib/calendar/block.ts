// Block time: the next free 30 minutes in working hours, and an .ics file for it. Pure.

import { addDays, localDate, zonedTime } from "@/lib/brief/time";
import type { CalendarEvent } from "@/lib/types";

export const WORK_START = "10:00";
export const WORK_END = "19:00";
const STEP_MIN = 15;
const DEFAULT_EVENT_MIN = 30;

/** Weekday of a local date, 0 = Sunday. */
const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();

/**
 * Start of the next free `minutes` between 10:00 and 19:00 local, Monday to Friday, on a
 * quarter hour, at least 5 minutes from now, overlapping none of `events` (an event without an
 * end counts as 30 minutes). Searches `days` days ahead; null when nothing is free.
 */
export function nextFreeSlot(events: CalendarEvent[], now: Date, timeZone: string, opts: { minutes?: number; days?: number } = {}): { start: Date; end: Date } | null {
  const len = (opts.minutes ?? 30) * 60_000;
  const busy = events
    .map((e) => {
      const s = Date.parse(e.startsAt);
      const end = e.endsAt ? Date.parse(e.endsAt) : s + DEFAULT_EVENT_MIN * 60_000;
      return [s, end] as const;
    })
    .filter(([s, e]) => !Number.isNaN(s) && !Number.isNaN(e))
    .sort((a, b) => a[0] - b[0]);
  const earliest = now.getTime() + 5 * 60_000;
  const step = STEP_MIN * 60_000;
  const today = localDate(now, timeZone);
  for (let d = 0; d < (opts.days ?? 14); d++) {
    const date = addDays(today, d);
    const wd = weekday(date);
    if (wd === 0 || wd === 6) continue;
    const dayStart = zonedTime(date, WORK_START, timeZone).getTime();
    const dayEnd = zonedTime(date, WORK_END, timeZone).getTime();
    let t = Math.max(dayStart, Math.ceil(earliest / step) * step);
    while (t + len <= dayEnd) {
      const clash = busy.find(([s, e]) => s < t + len && e > t);
      if (!clash) return { start: new Date(t), end: new Date(t + len) };
      t = Math.max(t + step, Math.ceil(clash[1] / step) * step);
    }
  }
  return null;
}

/** "20261126T043000Z" */
const icsTime = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** RFC 5545 text value: escape backslash, semicolon, comma and newlines. */
export function icsText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Fold a content line to 75 octets (continuation lines start with a space). */
function fold(line: string): string {
  const bytes = new TextEncoder();
  if (bytes.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = "";
  for (const ch of line) {
    const limit = out.length ? 74 : 75;
    if (bytes.encode(cur + ch).length > limit) { out.push(cur); cur = ch; } else cur += ch;
  }
  out.push(cur);
  return out.join("\r\n ");
}

/** A one-event calendar file. Times are UTC, so any calendar app shows them in its own zone. */
export function blockIcs(args: { uid: string; title: string; description?: string; start: Date; end: Date; now: Date }): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Daily brief//Block time//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${args.uid}`,
    `DTSTAMP:${icsTime(args.now)}`,
    `DTSTART:${icsTime(args.start)}`,
    `DTEND:${icsTime(args.end)}`,
    `SUMMARY:${icsText(args.title)}`,
    ...(args.description ? [`DESCRIPTION:${icsText(args.description)}`] : []),
    "TRANSP:OPAQUE",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}

/** "block-send-arjun-the-banner.ics" */
export function blockFileName(text: string): string {
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40).replace(/-$/, "");
  return `block-${slug || "time"}.ics`;
}
