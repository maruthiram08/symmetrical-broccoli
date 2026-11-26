// Promise timeline, related past items and the quiet streak. Pure: no API calls, simple scoring.

import { belongsTo, groupNames } from "@/lib/people";
import { addDays, localDate, localDayBounds } from "@/lib/brief/time";
import type { Item, Meeting } from "@/lib/types";

const STOP = new Set(
  ("the and for with that this from have will about into over your you our their them they she his her its are was were " +
    "been being can could would should just also then than when what which who whom how all any some not but get got " +
    "make made send share sent check let lets need needs want back next week today tomorrow").split(" "),
);

/** Content words of a text: lowercase, 3+ letters, minus common words. */
export function contentWords(s: string): Set<string> {
  return new Set(
    s.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, " ").split(/\s+/)
      .map((w) => (w.length > 4 && w.endsWith("s") ? w.slice(0, -1) : w))
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

/** Overlap of content words, 0..1 (Jaccard). */
export function overlap(a: string, b: string): number {
  const A = contentWords(a), B = contentWords(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / (A.size + B.size - n);
}

const live = (i: Item) => i.status !== "wrong";
const startOf = (byId: Map<string, Meeting>) => (i: Item) => byId.get(i.meetingId)?.startedAt ?? i.createdAt;

/** Same person, by People's matching (spelling variants merge). */
function samePerson(a: string | null, b: string | null, self: string[]): boolean {
  if (!a || !b) return false;
  const g = groupNames([a, b], self);
  return g.length === 1 && belongsTo(g[0], a) && belongsTo(g[0], b);
}

export type TimelineEvent =
  | { kind: "made"; at: string; quote: string; meeting: Meeting | null }
  | { kind: "mentioned"; at: string; itemId: string; text: string; quote: string; meeting: Meeting | null }
  | { kind: "due"; at: string; passed: boolean }
  | { kind: "closed"; at: string; quote: string; meeting: Meeting | null }
  | { kind: "marked"; at: string; status: "done" | "wrong" }
  | { kind: "open"; at: string };

const MENTION_MIN = 0.34;

/**
 * An item's life, oldest first: made (quote, meeting), mentioned again in a later meeting (a later
 * item with much the same words), due, closed by a meeting (close quote) or marked by you, and a
 * final "still open" when nothing closed it.
 */
export function timeline(item: Item, items: Item[], meetings: Meeting[], now: Date, self: string[] = []): TimelineEvent[] {
  const byId = new Map(meetings.map((m) => [m.id, m]));
  const start = startOf(byId);
  const madeAt = start(item);
  const out: TimelineEvent[] = [{ kind: "made", at: madeAt, quote: item.quote, meeting: byId.get(item.meetingId) ?? null }];

  const endAt = item.status !== "open" && item.closedAt ? item.closedAt : null;
  const seenMeetings = new Set([item.meetingId]);
  for (const o of items
    .filter((o) => o.id !== item.id && live(o) && start(o) > madeAt && (!endAt || start(o) <= endAt))
    .sort((a, b) => start(a).localeCompare(start(b)))) {
    if (seenMeetings.has(o.meetingId) || o.source === "manual") continue; // your own items aren't a meeting bringing it up
    const words = Math.max(overlap(o.text, item.text), overlap(o.quote, item.quote));
    const person = item.person ? samePerson(o.person, item.person, self) : true;
    if (words >= MENTION_MIN && person) {
      seenMeetings.add(o.meetingId);
      out.push({ kind: "mentioned", at: start(o), itemId: o.id, text: o.text, quote: o.quote, meeting: byId.get(o.meetingId) ?? null });
    }
  }

  if (item.dueAt && item.kind !== "decision") out.push({ kind: "due", at: item.dueAt, passed: Date.parse(item.dueAt) < (endAt ? Date.parse(endAt) : now.getTime()) });

  if (item.status === "done" && item.closeQuote && item.closedByMeetingId) {
    const m = byId.get(item.closedByMeetingId) ?? null;
    out.push({ kind: "closed", at: m?.startedAt ?? item.closedAt ?? now.toISOString(), quote: item.closeQuote, meeting: m });
  } else if (item.status === "done" || item.status === "wrong") {
    out.push({ kind: "marked", at: item.closedAt ?? now.toISOString(), status: item.status });
  } else if (item.kind !== "decision") {
    out.push({ kind: "open", at: now.toISOString() }); // open, or in the Inbox
  }
  const rank = (e: TimelineEvent) => (e.kind === "made" ? 0 : e.kind === "open" ? 2 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || a.at.localeCompare(b.at));
}

export interface RelatedItem {
  item: Item;
  meeting: Meeting | null;
  score: number;
  /** Why it showed: "Nitin", "banner, copy". */
  why: string;
}

/**
 * Up to `max` earlier items or decisions that look related: same person scores 1, plus word
 * overlap (Jaccard x 3). Needs at least one shared content word, or the same person on a decision.
 */
export function relatedItems(item: Item, items: Item[], meetings: Meeting[], self: string[] = [], max = 3): RelatedItem[] {
  const byId = new Map(meetings.map((m) => [m.id, m]));
  const start = startOf(byId);
  const at = start(item);
  const mine = contentWords(`${item.text} ${item.quote}`);
  const out: RelatedItem[] = [];
  for (const o of items) {
    if (o.id === item.id || !live(o) || o.source === "manual" || start(o) > at || (start(o) === at && o.meetingId === item.meetingId)) continue;
    const theirs = contentWords(`${o.text} ${o.quote}`);
    const shared = [...mine].filter((w) => theirs.has(w));
    const person = samePerson(o.person, item.person, self);
    const words = overlap(`${o.text} ${o.quote}`, `${item.text} ${item.quote}`);
    if (!shared.length && !person) continue;
    if (!shared.length && o.kind !== "decision" && !(person && o.kind === item.kind)) continue;
    const score = (person ? 1 : 0) + words * 3;
    if (score < 0.3) continue;
    out.push({ item: o, meeting: byId.get(o.meetingId) ?? null, score, why: [person ? o.person! : null, shared.slice(0, 3).join(", ") || null].filter(Boolean).join(" · ") });
  }
  return out.sort((a, b) => b.score - a.score || start(b.item).localeCompare(start(a.item))).slice(0, max);
}

/**
 * Days in a row, ending today, with nothing you owe or wait on overdue at any point of the day.
 * Counts back at most to the first meeting (no claims before the app knew anything). Wrong items don't count.
 */
export function quietStreak(items: Item[], meetings: Meeting[], now: Date, timeZone: string, maxDays = 60): number {
  if (!meetings.length) return 0;
  const first = localDate(new Date(meetings.reduce((a, m) => (m.startedAt < a ? m.startedAt : a), meetings[0].startedAt)), timeZone);
  const tasks = items.filter((i) => live(i) && i.kind !== "decision" && i.dueAt);
  // An item is overdue during [dueAt, closedAt or now).
  const spans = tasks.map((i) => [Date.parse(i.dueAt!), i.status === "open" ? now.getTime() : Date.parse(i.closedAt ?? i.dueAt!)] as const)
    .filter(([a, b]) => b > a);
  let date = localDate(now, timeZone);
  let n = 0;
  while (n < maxDays && date >= first) {
    const { startIso, endIso } = localDayBounds(date, timeZone);
    const s = Date.parse(startIso), e = Math.min(Date.parse(endIso), now.getTime());
    if (spans.some(([a, b]) => a < e && b > s)) break;
    n++;
    date = addDays(date, -1);
  }
  return n;
}

/** The quiet note, or null under `min` days. "Nothing overdue for 5 days." */
export function streakNote(days: number, min = 3): string | null {
  return days >= min ? `Nothing overdue for ${days} days.` : null;
}
