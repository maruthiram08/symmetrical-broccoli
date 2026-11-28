// Time helpers. All stored times are UTC ISO strings; everything shown is in the user's zone.

function parts(d: Date, timeZone: string) {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(d);
  const g = (t: string) => Number(f.find((p) => p.type === t)!.value);
  return { y: g("year"), mo: g("month"), d: g("day"), h: g("hour") % 24, mi: g("minute"), s: g("second") };
}

/** Minutes the zone is ahead of UTC at instant d. */
export function offsetMinutes(d: Date, timeZone: string): number {
  const p = parts(d, timeZone);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return Math.round((asUtc - Math.floor(d.getTime() / 1000) * 1000) / 60000);
}

/** Local calendar date "YYYY-MM-DD" of instant d. */
export function localDate(d: Date, timeZone: string): string {
  const p = parts(d, timeZone);
  return `${p.y}-${String(p.mo).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** UTC instant of local wall-clock time on a local date. */
export function zonedTime(date: string, hhmm: string, timeZone: string): Date {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let t = guess - offsetMinutes(new Date(guess), timeZone) * 60000;
  t = guess - offsetMinutes(new Date(t), timeZone) * 60000; // second pass settles DST edges
  return new Date(t);
}

/** [start, end) of the local day as UTC ISO strings. */
export function localDayBounds(date: string, timeZone: string): { startIso: string; endIso: string } {
  const start = zonedTime(date, "00:00", timeZone);
  const next = addDays(date, 1);
  return { startIso: start.toISOString(), endIso: zonedTime(next, "00:00", timeZone).toISOString() };
}

export function addDays(date: string, n: number): string {
  const [y, mo, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/** "1:51 PM" */
export function formatTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(iso));
}

/** "Wednesday, 25 November" */
export function dateLabel(date: string): string {
  const [y, mo, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d, 12));
  const wd = new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "UTC" }).format(t);
  const m = new Intl.DateTimeFormat("en-GB", { month: "long", timeZone: "UTC" }).format(t);
  return `${wd}, ${d} ${m}`;
}

/** "Today", "Tomorrow", "Fri" (within a week), else "3 Dec". */
export function dueLabel(dueIso: string, now: Date, timeZone: string): string {
  const today = localDate(now, timeZone);
  const due = localDate(new Date(dueIso), timeZone);
  if (due === today) return "Today";
  if (due === addDays(today, 1)) return "Tomorrow";
  const days = Math.round((Date.parse(due) - Date.parse(today)) / 86400000);
  const t = new Date(Date.parse(due) + 12 * 3600000);
  if (days > 1 && days < 7) return new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "UTC" }).format(t);
  return `${t.getUTCDate()} ${new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "UTC" }).format(t)}`;
}

/** "45m late", "4h late", "2d late" */
export function lateLabel(minutes: number): string {
  if (minutes < 60) return `${Math.max(1, minutes)}m late`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h late`;
  return `${Math.floor(minutes / 1440)}d late`;
}
