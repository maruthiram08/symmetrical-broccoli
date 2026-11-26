// Monthly review and Year in review: counts and lists over one local month or year. Pure.
//  made     promises you made (owe items said in a meeting, or added by you, in the period)
//  kept     promises closed as done in the period
//  late     promises made in the period that passed their due time open, or were kept after it
//  closed by meetings   items (owe or waiting) a later meeting closed in the period
// Items marked Wrong never count.

import { groupNames, normalizeName } from "@/lib/people";
import { localDayBounds } from "@/lib/brief/time";
import type { Item, Meeting, User } from "@/lib/types";

export type PeriodKind = "month" | "year";

export interface ReviewPeriod {
  kind: PeriodKind;
  /** "2026-11" or "2026". */
  key: string;
  /** "November 2026" or "2026". */
  label: string;
  startIso: string;
  endIso: string;
  prev: string;
  next: string;
}

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
const YEAR = /^\d{4}$/;
const pad = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The local month "YYYY-MM" in a zone, or null when the key isn't one. */
export function monthPeriod(key: string, timeZone: string): ReviewPeriod | null {
  const m = MONTH.exec(key);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]);
  const next = mo === 12 ? `${y + 1}-01` : `${y}-${pad(mo + 1)}`;
  const prev = mo === 1 ? `${y - 1}-12` : `${y}-${pad(mo - 1)}`;
  return {
    kind: "month", key, label: `${MONTHS[mo - 1]} ${y}`,
    startIso: localDayBounds(`${key}-01`, timeZone).startIso,
    endIso: localDayBounds(`${next}-01`, timeZone).startIso,
    prev, next,
  };
}

export function yearPeriod(key: string, timeZone: string): ReviewPeriod | null {
  if (!YEAR.test(key)) return null;
  const y = Number(key);
  return {
    kind: "year", key, label: key,
    startIso: localDayBounds(`${y}-01-01`, timeZone).startIso,
    endIso: localDayBounds(`${y + 1}-01-01`, timeZone).startIso,
    prev: String(y - 1), next: String(y + 1),
  };
}

export function periodFor(kind: PeriodKind, key: string, timeZone: string): ReviewPeriod | null {
  return kind === "month" ? monthPeriod(key, timeZone) : yearPeriod(key, timeZone);
}

export interface ReviewItem {
  id: string;
  kind: Item["kind"];
  text: string;
  person: string | null;
  quote: string;
  meetingTitle: string;
  madeAt: string;
  closedAt: string | null;
  closeQuote: string | null;
  /** How long it was (or has been) open, in minutes. */
  openMinutes: number;
  stillOpen: boolean;
}

export interface ReviewPerson {
  name: string;
  slug: string;
  /** Promises you made to them in the period. */
  made: number;
  kept: number;
  open: number;
}

export interface Review {
  period: ReviewPeriod;
  counts: {
    meetings: number;
    made: number;
    kept: number;
    late: number;
    closed: number;
    closedByMeetings: number;
    waiting: number;
    decisions: number;
  };
  /** People you promised most, most promises first (up to 8). */
  people: ReviewPerson[];
  /** Decisions per month (year) or per week (month). */
  decisionsBy: Array<{ key: string; label: string; count: number }>;
  longestOpen: ReviewItem[];
  fastestClosed: ReviewItem[];
}

export interface ReviewInput {
  items: Item[];
  meetings: Meeting[];
  user: Pick<User, "name" | "aliases" | "timeZone">;
  period: ReviewPeriod;
  now: Date;
  /** How many rows in the longest-open and fastest-closed lists. */
  listSize?: number;
}

const MIN = 60_000;

/** Local "YYYY-MM-DD" of an instant. */
function localDay(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

export function buildReview({ items, meetings, user, period, now, listSize = 5 }: ReviewInput): Review {
  const tz = user.timeZone;
  const byId = new Map(meetings.map((m) => [m.id, m]));
  const madeAt = (i: Item) => byId.get(i.meetingId)?.startedAt ?? i.createdAt;
  const inside = (iso: string | null) => !!iso && iso >= period.startIso && iso < period.endIso;
  const live = items.filter((i) => i.status !== "wrong");
  const made = live.filter((i) => inside(madeAt(i)));
  const nowMs = now.getTime();

  const owe = made.filter((i) => i.kind === "owe");
  const closedIn = live.filter((i) => i.kind !== "decision" && i.status === "done" && inside(i.closedAt));
  const isLate = (i: Item) => {
    if (!i.dueAt) return false;
    const due = Date.parse(i.dueAt);
    if (i.status === "done" && i.closedAt) return Date.parse(i.closedAt) > due;
    return due < nowMs;
  };

  const counts = {
    meetings: meetings.filter((m) => inside(m.startedAt)).length,
    made: owe.length,
    kept: closedIn.filter((i) => i.kind === "owe").length,
    late: owe.filter(isLate).length,
    closed: closedIn.length,
    closedByMeetings: closedIn.filter((i) => !!i.closedByMeetingId).length,
    waiting: made.filter((i) => i.kind === "waiting").length,
    decisions: made.filter((i) => i.kind === "decision").length,
  };

  // People you promised most: group spellings the way /people does.
  const self = [user.name, ...user.aliases].filter(Boolean);
  const groups = groupNames(owe.map((i) => i.person ?? "").filter(Boolean), self);
  const groupOf = new Map<string, (typeof groups)[number]>();
  for (const g of groups) for (const k of g.keys) groupOf.set(k, g);
  const tally = new Map<string, ReviewPerson>();
  for (const i of owe) {
    const g = i.person ? groupOf.get(normalizeName(i.person)) : undefined;
    if (!g) continue;
    const p = tally.get(g.slug) ?? { name: g.name, slug: g.slug, made: 0, kept: 0, open: 0 };
    p.made++;
    if (i.status === "done") p.kept++;
    else p.open++;
    tally.set(g.slug, p);
  }
  const people = [...tally.values()].sort((a, b) => b.made - a.made || a.name.localeCompare(b.name)).slice(0, 8);

  // Decisions by month (a year) or by week of the month (a month).
  const decisionsBy: Review["decisionsBy"] = [];
  const decided = made.filter((i) => i.kind === "decision").map((i) => localDay(madeAt(i), tz));
  if (period.kind === "year") {
    for (let m = 1; m <= 12; m++) {
      const key = `${period.key}-${pad(m)}`;
      decisionsBy.push({ key, label: MONTHS[m - 1].slice(0, 3), count: decided.filter((d) => d.startsWith(key)).length });
    }
  } else {
    const [y, mo] = period.key.split("-").map(Number);
    const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    const short = MONTHS[mo - 1].slice(0, 3);
    for (let from = 1; from <= days; from += 7) {
      const to = Math.min(days, from + 6);
      decisionsBy.push({
        key: `${period.key}-${pad(from)}`,
        label: `${from}–${to} ${short}`,
        count: decided.filter((d) => { const n = Number(d.slice(8, 10)); return n >= from && n <= to; }).length,
      });
    }
  }

  const row = (i: Item): ReviewItem => {
    const start = Date.parse(madeAt(i));
    const end = i.status === "done" && i.closedAt ? Date.parse(i.closedAt) : nowMs;
    return {
      id: i.id, kind: i.kind, text: i.text, person: i.person, quote: i.quote,
      meetingTitle: byId.get(i.meetingId)?.title ?? (i.source === "manual" ? "Added by you" : "a meeting"),
      madeAt: madeAt(i), closedAt: i.closedAt, closeQuote: i.closeQuote,
      openMinutes: Math.max(0, Math.round((end - start) / MIN)), stillOpen: i.status !== "done",
    };
  };
  const trackable = made.filter((i) => i.kind !== "decision");
  const longestOpen = trackable.map(row).sort((a, b) => b.openMinutes - a.openMinutes).slice(0, listSize);
  const fastestClosed = trackable
    .filter((i) => i.status === "done" && i.closedAt && Date.parse(i.closedAt) >= Date.parse(madeAt(i)))
    .map(row)
    .sort((a, b) => a.openMinutes - b.openMinutes)
    .slice(0, listSize);

  return { period, counts, people, decisionsBy, longestOpen, fastestClosed };
}

/** "12 min", "5 h", "3 d". */
export function durationLabel(minutes: number): string {
  if (minutes < 60) return `${Math.max(1, minutes)} min`;
  const h = Math.round(minutes / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(minutes / 1440)} d`;
}

/** Kept as a share of made, or null when nothing was made. */
export function keptRate(c: Review["counts"]): number | null {
  return c.made ? Math.round((Math.min(c.kept, c.made) / c.made) * 100) : null;
}

/** The current month and year keys in a zone. */
export function currentKeys(now: Date, timeZone: string): { month: string; year: string } {
  const d = localDay(now.toISOString(), timeZone);
  return { month: d.slice(0, 7), year: d.slice(0, 4) };
}
