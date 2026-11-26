// Natural-language dates for jumping to a day: "yesterday", "last tuesday", "3 days ago",
// "next fri", "25 nov", "2026-11-03". Only a query that is a date, as a whole, counts, so
// "send the deck friday" stays a search.
import * as chrono from "chrono-node";

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_FIRST = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(st|nd|rd|th)?(,?\s+\d{4})?$/i;

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** True for a real calendar date written YYYY-MM-DD. */
export function validDay(s: string): boolean {
  const m = s.match(ISO);
  if (!m) return false;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]);
}

/**
 * The day a query names, counted from `today` (YYYY-MM-DD in your time zone), or null.
 * Calendar maths runs on local dates at noon, so the result doesn't depend on the machine's zone.
 */
export function parseDayQuery(q: string, today: string): string | null {
  const s = q.trim().replace(/^(?:go to|open|day|jump to)\s+/i, "").replace(/[.!?]+$/, "").trim();
  if (!s || s.length > 40 || !validDay(today)) return null;
  if (ISO.test(s)) return validDay(s) ? s : null;
  const [y, m, d] = today.split("-").map(Number);
  const ref = new Date(y, m - 1, d, 12, 0, 0, 0);
  const parser = MONTH_FIRST.test(s) ? chrono.casual : chrono.en.GB;
  const r = parser.parse(s, ref)[0];
  if (!r || r.index !== 0 || r.text.trim().length < s.length) return null;
  // A time on its own ("5pm") isn't a day.
  if (!r.start.isCertain("day") && !r.start.isCertain("weekday") && !r.start.isCertain("month")) return null;
  const out = ymd(r.start.date());
  return validDay(out) ? out : null;
}
