// Recurring meetings without a calendar: meetings that start at the same local time (to the half
// hour) on three or more different weekdays in the last 30 days, like a daily standup.
import { localDate, offsetMinutes, zonedTime } from "../brief/time";
import type { Meeting } from "../types";

export interface Slot {
  /** "11:00", local. Also the prep view's ?slot= value. */
  key: string;
  /** "11:00 AM". */
  label: string;
  meetings: Meeting[];
  /** The next weekday start at that time, ISO UTC. */
  next: string;
}

export const SLOT_MIN = 3;

function localMinutes(iso: string, tz: string): number {
  const d = new Date(iso);
  const m = (d.getUTCHours() * 60 + d.getUTCMinutes() + offsetMinutes(d, tz) + 1440) % 1440;
  return Math.round(m / 30) * 30 % 1440;
}

const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
export function clockLabel(min: number): string {
  const h = Math.floor(min / 60), m = min % 60;
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** The next weekday at `min` local minutes after now, as UTC ISO. */
export function nextAt(min: number, now: Date, tz: string): string {
  for (let d = 0; d < 8; d++) {
    const probe = new Date(now.getTime() + d * 86400000);
    const date = localDate(probe, tz);
    const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const at = zonedTime(date, hhmm(min), tz).getTime();
    if (at > now.getTime()) return new Date(at).toISOString();
  }
  return now.toISOString();
}

export function findSlots(meetings: Meeting[], now: Date, tz: string, days = 30): Slot[] {
  const since = now.getTime() - days * 86400000;
  const by = new Map<number, Meeting[]>();
  for (const m of meetings) {
    if (m.duplicateOf || Date.parse(m.startedAt) < since || Date.parse(m.startedAt) > now.getTime()) continue;
    const k = localMinutes(m.startedAt, tz);
    (by.get(k) ?? by.set(k, []).get(k)!).push(m);
  }
  return [...by]
    .map(([min, ms]) => ({ min, ms: ms.sort((a, b) => b.startedAt.localeCompare(a.startedAt)) }))
    .filter(({ ms }) => new Set(ms.map((m) => localDate(new Date(m.startedAt), tz))).size >= SLOT_MIN)
    .sort((a, b) => b.ms.length - a.ms.length)
    .map(({ min, ms }) => ({ key: hhmm(min), label: clockLabel(min), meetings: ms, next: nextAt(min, now, tz) }));
}
