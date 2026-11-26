// Cadence words to a Cadence, locally and with no AI: "every Monday", "weekdays at 10", "monthly on
// the 1st", "every 3 days", and Hinglish "har Friday", "roz", "har mahine". Used by quick capture
// ("every Monday send sprint report to Tarun") and for the `recurrence` words the meeting reader returns.
// The cadence is read here; chrono-node only reads the time of day.
import * as chrono from "chrono-node";
import { parseCapture, type ParseContext } from "@/lib/capture/parse";
import { localDate } from "@/lib/brief/time";
import { dayOfWeek } from "./schedule";
import type { Cadence, Weekday } from "./types";

export interface ParsedCadence {
  cadence: Cadence;
  /** "HH:MM" when a time of day was said. */
  time: string | null;
  /** The text with the cadence and time words taken out. */
  rest: string;
}

const DAY_WORDS: Array<[RegExp, Weekday]> = [
  [/^(?:sun(?:day)?|ravi(?:vaar|var|war))$/, 0],
  [/^(?:mon(?:day)?|som(?:vaar|var|war))$/, 1],
  [/^(?:tue(?:s(?:day)?)?|mangal(?:vaar|var|war))$/, 2],
  [/^(?:wed(?:nes(?:day)?)?|budh(?:vaar|var|war))$/, 3],
  [/^(?:thu(?:r(?:s(?:day)?)?)?|guru(?:vaar|var|war))$/, 4],
  [/^(?:fri(?:day)?|shukra(?:vaar|var|war))$/, 5],
  [/^(?:sat(?:urday)?|shani(?:vaar|var|war))$/, 6],
];
const DAY = "(?:sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|(?:ravi|som|mangal|budh|guru|shukra|shani)(?:vaar|var|war))s?";
/** "Mondays": only the full names, so "Thurs" or "Tues" (one day) never reads as a routine. */
const PLURAL = "(?:sun|mon|tues|wednes|thurs|fri|satur)days";
const DAYS = `${DAY}(?:\\s*(?:,|and|&|\\/|aur)\\s*${DAY})*`;

function dayOf(word: string): Weekday | null {
  const w = word.toLowerCase().replace(/s$/, "");
  for (const [re, d] of DAY_WORDS) if (re.test(w) || re.test(word.toLowerCase())) return d;
  return null;
}

function daysIn(s: string): Weekday[] {
  const out = new Set<Weekday>();
  for (const w of s.split(/[\s,&/]+|\band\b|\baur\b/i)) {
    const d = w.trim() ? dayOf(w.trim()) : null;
    if (d !== null) out.add(d);
  }
  return [...out].sort();
}

const B = "(?<![\\p{L}\\p{N}])";
const E = "(?![\\p{L}\\p{N}])";
const re = (s: string) => new RegExp(`${B}${s}${E}`, "iu");

type Rule = [RegExp, (m: RegExpMatchArray, anchor: string) => Cadence | null];

const RULES: Rule[] = [
  [re("every\\s+other\\s+day|alternate\\s+days|ek\\s+din\\s+chhod\\s+ke"), (_m, a) => ({ kind: "every", n: 2, from: a })],
  [re("every\\s+(\\d{1,3})\\s+days|har\\s+(\\d{1,3})\\s+din"), (m, a) => ({ kind: "every", n: Number(m[1] ?? m[2]), from: a })],
  [re("every\\s+(?:2|two|other)\\s+weeks|fortnightly|biweekly|bi-weekly"), (_m, a) => ({ kind: "every", n: 14, from: a })],
  [re("(?:every|each|on)\\s+(?:weekday|working\\s+day|work\\s+day|business\\s+day)s?|weekdays|monday\\s+(?:to|through|-)\\s+friday|mon\\s*-\\s*fri"), () => ({ kind: "weekdays" })],
  [re("(?:every|each|on)\\s+weekends?|weekends"), () => ({ kind: "weekly", days: [0, 6] })],
  // "on the 1st of every month", "every month on the 15th", "monthly on the 1st", "har mahine ki 5 tareekh"
  [re("(?:on\\s+)?the\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s+of\\s+(?:every|each|the)\\s+month"), (m) => monthly(m[1])],
  [re("(?:every|each)\\s+(\\d{1,2})(?:st|nd|rd|th)\\s+(?:of\\s+the\\s+month)?"), (m) => monthly(m[1])],
  [re("(?:every\\s+month|each\\s+month|monthly)\\s*(?:,\\s*)?on\\s+the\\s+(\\d{1,2})(?:st|nd|rd|th)?"), (m) => monthly(m[1])],
  [re("(?:every\\s+month|each\\s+month|monthly)\\s+on\\s+the\\s+last\\s+day|(?:on\\s+)?the\\s+last\\s+day\\s+of\\s+(?:every|each|the)\\s+month|(?:at\\s+the\\s+)?end\\s+of\\s+(?:every|each)\\s+month"), () => ({ kind: "monthly", day: 31 })],
  [re("har\\s+mahine\\s+(?:ki\\s+)?(\\d{1,2})(?:\\s+(?:tareekh|tarikh|taarikh))?"), (m) => monthly(m[1])],
  [re("(?:every|each)\\s+month|monthly|har\\s+mahin[ae]|har\\s+month"), (_m, a) => monthly(a.slice(8, 10))],
  // Days of the week: "every Monday and Thursday", "har Friday", "weekly on Fri", "on Mondays", "Fridays".
  [re(`(?:every|each|har|weekly\\s+on|every\\s+week\\s+on)\\s+(${DAYS})`), (m) => weekly(m[1])],
  [re(`(?:on\\s+)?(${PLURAL}(?:\\s*(?:,|and|&)\\s*${PLURAL})*)`), (m) => weekly(m[1])],
  [re("(?:every|each)\\s+(?:single\\s+)?day|everyday|daily|har\\s+din|roz(?:ana|aana)?|rozaana|din\\s+mein\\s+ek\\s+baar"), () => ({ kind: "daily" })],
  [re("(?:every|each)\\s+week|weekly|har\\s+(?:hafte|hafta|week)"), (_m, a) => ({ kind: "weekly", days: [dayOfWeek(a) as Weekday] })],
];

function monthly(day: string): Cadence | null {
  const n = Number(day);
  return n >= 1 && n <= 31 ? { kind: "monthly", day: n } : null;
}

function weekly(words: string): Cadence | null {
  const days = daysIn(words);
  return days.length ? { kind: "weekly", days } : null;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A time of day in the text ("at 10", "10:30am", "at 6 pm", "10 baje"), and the text without it. */
export function parseTimeOfDay(text: string): { time: string | null; rest: string } {
  const baje = text.match(/(?<![\p{L}\p{N}])(\d{1,2})(?::(\d{2}))?\s*baje(?![\p{L}\p{N}])/iu);
  if (baje && baje.index !== undefined && Number(baje[1]) < 24 && Number(baje[2] ?? 0) < 60) {
    return { time: `${pad(Number(baje[1]))}:${pad(Number(baje[2] ?? 0))}`, rest: cut(text, baje.index, baje[0].length) };
  }
  // A fixed reference date: only the hour and minute are read.
  const ref = new Date(Date.UTC(2026, 0, 5, 12));
  for (const r of chrono.en.GB.parse(text, ref)) {
    const s = r.start;
    if (!s.isCertain("hour") || s.isCertain("day") || s.isCertain("weekday") || s.isCertain("month")) continue;
    // A bare number ("send 2 decks") is no time: chrono only counts it with "at", a colon or am/pm.
    if (!/[:.]|am|pm|noon|midnight|^\s*at\b/i.test(r.text) && !/\bat\s*$/i.test(text.slice(0, r.index))) continue;
    const h = s.get("hour") ?? 0, mi = s.get("minute") ?? 0;
    let start = r.index;
    const before = text.slice(0, start).match(/\b(?:at|by|around)\s*$/i);
    if (before) start -= before[0].length;
    return { time: `${pad(h)}:${pad(mi)}`, rest: cut(text, start, r.index + r.text.length - start) };
  }
  return { time: null, rest: text };
}

function cut(s: string, at: number, len: number): string {
  return tidy(`${s.slice(0, at)} ${s.slice(at + len)}`);
}

function tidy(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;!?])/g, "$1")
    .replace(/(?:^|\s)(?:on|at|by|every|each)\s*$/i, "")
    .replace(/^[\s,;:-]+|[\s,;:.!-]+$/g, "")
    .trim();
}

/**
 * The cadence (and time) said in `text`, or null when none is. `anchor` is the local date that
 * a bare "weekly" or "monthly" counts from (today, or the meeting's day): its weekday or day of month.
 */
export function parseCadence(text: string, anchor: string): ParsedCadence | null {
  for (const [rule, make] of RULES) {
    const m = text.match(rule);
    if (!m || m.index === undefined) continue;
    const cadence = make(m, anchor);
    if (!cadence) continue;
    const { time, rest } = parseTimeOfDay(cut(text, m.index, m[0].length));
    return { cadence, time, rest };
  }
  return null;
}

export interface ParsedRoutine {
  title: string;
  person: string | null;
  cadence: Cadence;
  time: string | null;
}

/**
 * Quick capture: a line that says a cadence is a routine ("every Monday send sprint report to
 * Tarun"). Null when the line has no cadence, or reads as something someone else owes you.
 */
export function parseRoutineCapture(line: string, ctx: ParseContext): ParsedRoutine | null {
  const today = localDate(ctx.now, ctx.timeZone);
  const c = parseCadence(line, today);
  if (!c || !c.rest) return null;
  const p = parseCapture(c.rest, ctx);
  if (p.kind !== "owe") return null;
  return { title: p.text, person: p.person, cadence: c.cadence, time: c.time };
}
