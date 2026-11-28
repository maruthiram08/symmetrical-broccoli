// Quick capture: turn one line of plain text into an item, locally, with no AI.
// "send Nitin the deck by Fri"         -> owe,     Nitin, due Friday
// "Tarun owes me API spec tomorrow"    -> waiting, Tarun, due tomorrow, "Tarun to send API spec"

import { addDays, localDate, zonedTime } from "@/lib/brief/time";

export interface Parsed {
  kind: "owe" | "waiting";
  /** Item text, verb first for things you owe, "<Person> to ..." for things you wait on. */
  text: string;
  person: string | null;
  /** Local date "YYYY-MM-DD", or null when no date was said. */
  dueDate: string | null;
  /** 18:00 local on dueDate (the same "end of day" the extractor uses), as UTC ISO. */
  dueAt: string | null;
}

export interface ParseContext {
  /** Names already known (people on items and in meetings). Matched first, and their spelling wins. */
  people: string[];
  /** Your own name and aliases: never the other person. */
  self?: string[];
  now: Date;
  timeZone: string;
}

/** Due time for a local date: 18:00, as the extractor does for "by EOD". */
export const DUE_TIME = "18:00";

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WD = "(sun|mon|tue|wed|thu|fri|sat)(?:day|s|sday|nesday|rsday|urday|\\.)?";
const MON = "(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
const LEAD = "(?:(?:by|on|before|due|until|for|this|till)\\s+)?";

/** Day of week (0 = Sunday) of a local date. */
function dow(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function pad(n: number) { return String(n).padStart(2, "0"); }

function validDate(y: number, m: number, d: number): string | null {
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** A day and month without a year: this year, or next year when it has passed. */
function nextDayMonth(today: string, m: number, d: number): string | null {
  const y = Number(today.slice(0, 4));
  const here = validDate(y, m, d);
  if (here && here >= today) return here;
  return validDate(y + 1, m, d);
}

type Rule = [RegExp, (m: RegExpMatchArray, today: string) => string | null];

const RULES: Rule[] = [
  [new RegExp(`\\b${LEAD}(?:the\\s+)?day\\s+after\\s+tomorrow\\b`, "i"), (_m, t) => addDays(t, 2)],
  [new RegExp(`\\b${LEAD}(?:tomorrow|tmrw|tmr|tomorow|tommorow)(?:\\s+(?:morning|evening|eod))?\\b`, "i"), (_m, t) => addDays(t, 1)],
  [new RegExp(`\\b${LEAD}(?:today|tonight|eod|end\\s+of\\s+(?:the\\s+)?day)\\b`, "i"), (_m, t) => t],
  [new RegExp(`\\b${LEAD}(?:end\\s+of\\s+(?:the\\s+)?week|eow)\\b`, "i"), (_m, t) => addDays(t, (5 - dow(t) + 7) % 7)],
  [new RegExp(`\\b${LEAD}next\\s+week\\b`, "i"), (_m, t) => addDays(t, ((1 - dow(t) + 7) % 7) || 7)],
  [/\b(?:with)?in\s+(\d{1,2})\s+days?\b/i, (m, t) => addDays(t, Number(m[1]))],
  [/\b(?:by|on|before|due|until)?\s*(\d{4})-(\d{2})-(\d{2})\b/i, (m) => validDate(Number(m[1]), Number(m[2]), Number(m[3]))],
  [new RegExp(`\\b${LEAD}(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MON}(?=\\s|$|[,.;!?])`, "i"),
    (m, t) => nextDayMonth(t, MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1, Number(m[1]))],
  [new RegExp(`\\b${LEAD}${MON}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "i"),
    (m, t) => nextDayMonth(t, MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1, Number(m[2]))],
  // "next Fri" is the Friday after the coming one only when the coming one is this week's: keep it simple, +7 from the next.
  [new RegExp(`\\b${LEAD}next\\s+${WD}(?=\\s|$|[,.;!?])`, "i"), (m, t) => {
    const n = (WEEKDAYS.indexOf(m[1].toLowerCase()) - dow(t) + 7) % 7 || 7;
    return addDays(t, n);
  }],
  // A weekday means the next such day; said on that day, it means today.
  [new RegExp(`\\b${LEAD}${WD}(?=\\s|$|[,.;!?])`, "i"), (m, t) => addDays(t, (WEEKDAYS.indexOf(m[1].toLowerCase()) - dow(t) + 7) % 7)],
];

/** Find a due date in the text. Returns the date and the text without the phrase. */
export function parseDue(text: string, today: string): { date: string | null; rest: string } {
  for (const [re, fn] of RULES) {
    const m = text.match(re);
    if (!m || m.index === undefined) continue;
    // "may" the verb, "sat" in "sat down", "wed" in "wedding" are guarded by the word boundaries;
    // a bare "May" with no day number never matches the month rules.
    const date = fn(m, today);
    if (!date) continue;
    const rest = (text.slice(0, m.index) + " " + text.slice(m.index + m[0].length));
    return { date, rest: tidy(rest) };
  }
  return { date: null, rest: tidy(text) };
}

function tidy(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;!?])/g, "$1")
    .replace(/(?:\s|^)(?:by|on|before|due|until|till)\s*$/i, "")
    .replace(/^[\s,;:-]+|[\s,;:.!-]+$/g, "")
    .trim();
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const fold = (s: string) => s.normalize("NFKC").toLowerCase().trim();

/**
 * A known person named in the text, as the known spelling. The longest name wins ("Nitin K"
 * over "Nitin"); a first name alone matches a known full name when only one person has it.
 */
export function findPerson(text: string, people: string[], self: string[] = []): { name: string; at: number; len: number } | null {
  const skip = new Set(self.map(fold).filter(Boolean));
  const known = [...new Set(people.map((p) => p.trim()).filter((p) => p && !skip.has(fold(p))))];
  const ranked = [...known].sort((a, b) => b.length - a.length);
  for (const name of ranked) {
    const m = text.match(new RegExp(`(?<![\\p{L}\\p{N}])${esc(name)}(?![\\p{L}\\p{N}])`, "iu"));
    if (m && m.index !== undefined) return { name, at: m.index, len: m[0].length };
  }
  // First name only: "Nitin" -> "Nitin K" when exactly one known person is called Nitin.
  const byFirst = new Map<string, string[]>();
  for (const name of known) {
    const first = fold(name).split(/\s+/)[0];
    if (first.length >= 2) byFirst.set(first, [...(byFirst.get(first) ?? []), name]);
  }
  for (const [first, names] of byFirst) {
    const m = text.match(new RegExp(`(?<![\\p{L}\\p{N}])${esc(first)}(?![\\p{L}\\p{N}])`, "iu"));
    if (!m || m.index === undefined || skip.has(first)) continue;
    // Prefer the shortest spelling ("Nitin" over "Nitin K") so the item reads as typed.
    const pick = names.length === 1 ? names[0] : names.find((n) => fold(n) === first);
    if (pick) return { name: pick, at: m.index, len: m[0].length };
  }
  return null;
}

const NAME = "([A-Z][\\p{L}'-]+(?:\\s+[A-Z][\\p{L}'.-]*)?)";
const VERBS = "send|tell|ask|email|mail|call|ping|remind|pay|give|show|share|message|text|update|introduce|invite|meet|thank|reply to|follow up with|get back to|sync with|check with|loop in";
const STOP = new Set(["I", "Me", "The", "A", "An", "Send", "Get", "Ask", "Call", "Email", "Review", "Share", "Write", "Book", "Waiting", "Today", "Tomorrow", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]);

/** An unknown name, by position: right after a verb ("send Ravi ...") or "to/for/with/from Ravi". */
function guessPerson(text: string, self: string[]): string | null {
  const skip = new Set(self.map(fold));
  const pats = [
    new RegExp(`\\b(?:${VERBS})\\s+${NAME}`, "u"),
    new RegExp(`\\b(?:to|for|with|from)\\s+${NAME}`, "u"),
  ];
  for (const re of pats) {
    const m = text.match(re);
    if (!m) continue;
    const name = m[1].split(/\s+/).filter((w, i) => i === 0 || /^[A-Z]/.test(w)).join(" ").replace(/'s$/, "");
    const first = name.split(" ")[0];
    if (STOP.has(first) || skip.has(fold(name)) || skip.has(fold(first))) continue;
    // A second capitalised word is only part of the name when it is short ("Nitin K").
    const parts = name.split(" ");
    return parts.length > 1 && parts[1].replace(/\./g, "").length > 2 ? parts[0] : name;
  }
  return null;
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** "Tarun will review the doc" -> "review the doc". Strips the helper verb after the name. */
function afterName(rest: string): string {
  return rest
    .replace(/^(?:will|should|is going to|is gonna|has to|needs to|to|'ll|’ll|said (?:he|she|they)(?:'ll| will)|promised to)\s+/i, "")
    .trim();
}

/** A thing owed, as an action: "API spec" -> "send API spec"; "review the doc" stays. */
function asAction(thing: string): string {
  const t = thing.trim();
  if (/^(?:send|share|review|confirm|finish|write|book|fix|call|reply|get|check|update|deliver|sign|approve|send over|look at|give)\b/i.test(t)) return t;
  return `send ${t}`;
}

/**
 * Parse one line. Your own items are "owe" unless the line says someone owes you:
 * "<Name> owes me ...", "waiting on <Name> for ...", "<Name> will/to ...", "... from <Name>".
 */
export function parseCapture(input: string, ctx: ParseContext): Parsed {
  const today = localDate(ctx.now, ctx.timeZone);
  const self = ctx.self ?? [];
  let line = input.replace(/\s+/g, " ").trim()
    .replace(/^(?:todo|owe|task)\s*:\s*/i, "")
    .replace(/^(?:i\s+(?:need\s+to|have\s+to|must|should|will|'ll|’ll)|i'll|i’ll|remind\s+me\s+to|need\s+to|gotta)\s+/i, "");
  let forceWaiting = false;
  if (/^(?:waiting|wait)\s*:\s*/i.test(line)) { forceWaiting = true; line = line.replace(/^(?:waiting|wait)\s*:\s*/i, ""); }

  const { date, rest } = parseDue(line, today);
  const dueAt = date ? zonedTime(date, DUE_TIME, ctx.timeZone).toISOString() : null;
  const found = findPerson(rest, ctx.people, self);
  const person = found?.name ?? guessPerson(rest, self);
  const done = (kind: Parsed["kind"], text: string, who: string | null = person): Parsed =>
    ({ kind, text: cap(tidy(text)) || cap(rest) || input.trim(), person: who, dueDate: date, dueAt });

  // Patterns that need the name at a position: match it as a known name or any capitalised word(s).
  const nameRe = found ? esc(rest.slice(found.at, found.at + found.len)) : "[\\p{L}][\\p{L}'.-]*(?:\\s+[A-Z][\\p{L}'.-]*)?";
  const shown = (raw: string) => found?.name ?? cap(raw.trim());

  let m = rest.match(new RegExp(`^(${nameRe})\\s+(?:owes|owe)\\s+(?:me|us)\\s+(.+)$`, "iu"));
  if (m) return done("waiting", `${shown(m[1])} to ${asAction(m[2])}`, shown(m[1]));

  m = rest.match(new RegExp(`^(?:waiting|wait)\\s+(?:on|for)\\s+(${nameRe})(\\s+to\\s+|\\s+for\\s+|\\s*[,:-]\\s*|\\s+)(.+)$`, "iu"));
  if (m) return done("waiting", `${shown(m[1])} to ${/^\s+to\s+$/i.test(m[2]) ? m[3] : asAction(m[3])}`, shown(m[1]));

  m = rest.match(new RegExp(`^(${nameRe})\\s*(?:will|should|is going to|is gonna|to|'ll|’ll|promised to|said (?:he|she|they)(?:'ll| will))\\s+(.+)$`, "iu"));
  if (m && (found || /^[A-Z]/.test(m[1])) && !STOP.has(cap(m[1].split(" ")[0]))) {
    return done("waiting", `${shown(m[1])} to ${afterName(m[2])}`, shown(m[1]));
  }

  m = rest.match(new RegExp(`^(?:get|collect|chase|need)\\s+(.+?)\\s+from\\s+(${nameRe})$`, "iu"));
  if (m) return done("waiting", `${shown(m[2])} to ${asAction(m[1])}`, shown(m[2]));
  m = rest.match(new RegExp(`^(.+?)\\s+from\\s+(${nameRe})$`, "iu"));
  if (m && !/^(?:send|share|forward|ask|email|tell|pick|buy|order)\b/i.test(m[1]) && (found || /^[A-Z]/.test(m[2]))) {
    return done("waiting", `${shown(m[2])} to ${asAction(m[1])}`, shown(m[2]));
  }

  if (forceWaiting) {
    const who = person;
    return done("waiting", who && !new RegExp(esc(who), "i").test(rest) ? `${who} to ${rest}` : rest, who);
  }

  // Something you owe: keep the words, with the known spelling of the name ("nitin" -> "Nitin").
  let text = rest;
  if (found) {
    const typed = rest.slice(found.at, found.at + found.len);
    if (fold(found.name).startsWith(fold(typed))) text = rest.slice(0, found.at) + found.name.slice(0, typed.length) + rest.slice(found.at + found.len);
  }
  return done("owe", text);
}
