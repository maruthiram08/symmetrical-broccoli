// When a routine is due. Pure: every function works on local dates (YYYY-MM-DD) in the user's zone,
// which callers get from localDate(now, timeZone) (src/lib/brief/time), so DST never moves a day.
import { addDays, localDate, zonedTime } from "@/lib/brief/time";
import type { Cadence, Occurrence, Routine, RoutineLine } from "./types";
import { cadenceLabel, shortDay } from "./words";

/** Missed occurrences older than this many days (counting today) are let go. */
export const OVERDUE_WINDOW_DAYS = 7;
/** How far nextDue looks ahead before giving up (a bad cadence never loops forever). */
const LOOKAHEAD_DAYS = 400;
/** A notification for a timed routine still goes out this long after its time (a Mac that just woke). */
export const NOTIFY_LATE_MS = 2 * 60 * 60_000;

/** Day of the week of a local date, 0 = Sunday. */
export function dayOfWeek(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Days in the month of a local date. */
function daysInMonth(date: string): number {
  const [y, m] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Whole days from a to b (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** True when the cadence falls on this local date. */
export function isDueOn(c: Cadence, date: string): boolean {
  switch (c.kind) {
    case "daily": return true;
    case "weekdays": { const d = dayOfWeek(date); return d >= 1 && d <= 5; }
    case "weekly": return c.days.includes(dayOfWeek(date) as never);
    case "monthly": return Number(date.slice(8, 10)) === Math.min(Math.max(1, Math.floor(c.day)), daysInMonth(date));
    case "every": {
      const n = Math.max(1, Math.floor(c.n));
      const diff = daysBetween(c.from, date);
      return diff >= 0 && diff % n === 0;
    }
  }
}

/** Due local dates in [from, to], oldest first. */
export function dueDatesBetween(c: Cadence, from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from, k = 0; d <= to && k <= LOOKAHEAD_DAYS; d = addDays(d, 1), k++) if (isDueOn(c, d)) out.push(d);
  return out;
}

/** The local date a routine started: nothing before it is ever due or overdue. */
export function startDate(r: Pick<Routine, "createdAt">, timeZone: string): string {
  return localDate(new Date(r.createdAt), timeZone);
}

const ofRoutine = (occ: Occurrence[], id: string) => occ.filter((o) => o.routineId === id);

/** The latest occurrence marked done (not skipped), or null. */
export function lastDone(occ: Occurrence[], routineId: string): string | null {
  let best: string | null = null;
  for (const o of ofRoutine(occ, routineId)) if (o.status === "done" && (!best || o.date > best)) best = o.date;
  return best;
}

/** The latest occurrence done or skipped: what was missed before it no longer counts. */
function lastResolved(occ: Occurrence[], routineId: string): string | null {
  let best: string | null = null;
  for (const o of ofRoutine(occ, routineId)) if (o.status !== "snoozed" && (!best || o.date > best)) best = o.date;
  return best;
}

/**
 * The occurrences still open on `today`: due dates since the last done/skipped one, inside the
 * window, not before the routine started, and not snoozed past today. Oldest first.
 */
export function openOccurrences(r: Routine, occ: Occurrence[], today: string, timeZone: string): string[] {
  if (r.archived) return [];
  const mine = ofRoutine(occ, r.id);
  const resolved = lastResolved(mine, r.id);
  let from = addDays(today, -(OVERDUE_WINDOW_DAYS - 1));
  const start = startDate(r, timeZone);
  if (start > from) from = start;
  if (resolved && addDays(resolved, 1) > from) from = addDays(resolved, 1);
  if (from > today) return [];
  const byDate = new Map(mine.map((o) => [o.date, o]));
  return dueDatesBetween(r.cadence, from, today).filter((d) => {
    const o = byDate.get(d);
    if (!o) return true;
    return o.status === "snoozed" && !!o.until && o.until <= today;
  });
}

/** The routine's line for Today and the brief, or null when nothing of it is due or overdue. */
export function routineLine(r: Routine, occ: Occurrence[], today: string, timeZone: string): RoutineLine | null {
  const open = openOccurrences(r, occ, today, timeZone);
  if (!open.length) return null;
  const date = open[open.length - 1];
  const overdueSince = open[0] < today ? open[0] : null;
  return {
    routineId: r.id, title: r.title, person: r.person, time: r.time, cadenceLabel: cadenceLabel(r.cadence, r.time),
    date, overdueSince, overdueLabel: overdueSince ? `overdue since ${sinceLabel(overdueSince, today)}` : null,
  };
}

/** "Mon" within the last week, else "20 Nov". */
export function sinceLabel(date: string, today: string): string {
  const days = daysBetween(date, today);
  return days >= 1 && days < 7 ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dayOfWeek(date)] : shortDay(date);
}

/**
 * Lines for every active routine due or overdue today. Due today first (by time, untimed last),
 * then the ones only overdue, oldest first.
 */
export function routinesDue(routines: Routine[], occ: Occurrence[], today: string, timeZone: string): RoutineLine[] {
  const lines = routines.map((r) => routineLine(r, occ, today, timeZone)).filter((l): l is RoutineLine => !!l);
  const key = (l: RoutineLine) => (l.date === today ? `0 ${l.time ?? "99:99"}` : `1 ${l.date}`);
  return lines.sort((a, b) => key(a).localeCompare(key(b)) || a.title.localeCompare(b.title));
}

/** The next due date from today on that isn't done or skipped yet (today when today's is still open). */
export function nextDue(r: Routine, occ: Occurrence[], today: string, timeZone: string): string | null {
  const start = startDate(r, timeZone);
  const from = start > today ? start : today;
  const closed = new Set(ofRoutine(occ, r.id).filter((o) => o.status !== "snoozed").map((o) => o.date));
  for (let d = from, k = 0; k <= LOOKAHEAD_DAYS; d = addDays(d, 1), k++) if (isDueOn(r.cadence, d) && !closed.has(d)) return d;
  return null;
}

/**
 * Done in a row: walking back from the latest due day (today only once it's done), each done
 * occurrence counts, a skipped one is passed over, and anything else ends the streak.
 */
export function streak(r: Routine, occ: Occurrence[], today: string, timeZone: string): number {
  const byDate = new Map(ofRoutine(occ, r.id).map((o) => [o.date, o.status]));
  const start = startDate(r, timeZone);
  let n = 0;
  for (let d = today, k = 0; d >= start && k <= LOOKAHEAD_DAYS; d = addDays(d, -1), k++) {
    if (!isDueOn(r.cadence, d)) continue;
    const s = byDate.get(d);
    if (s === "done") n++;
    else if (s === "skipped") continue;
    else if (d === today) continue; // today isn't missed yet
    else break;
  }
  return n;
}

/**
 * Should a timed routine's notification go out now? Due today, its time has passed by less than
 * NOTIFY_LATE_MS, and today's occurrence is neither done, skipped nor snoozed.
 */
export function notifyDue(r: Routine, occ: Occurrence[], now: Date, timeZone: string): string | null {
  if (r.archived || !r.time) return null;
  const today = localDate(now, timeZone);
  if (!isDueOn(r.cadence, today) || startDate(r, timeZone) > today) return null;
  if (ofRoutine(occ, r.id).some((o) => o.date === today)) return null;
  const at = zonedTime(today, r.time, timeZone).getTime();
  return now.getTime() >= at && now.getTime() - at < NOTIFY_LATE_MS ? today : null;
}
