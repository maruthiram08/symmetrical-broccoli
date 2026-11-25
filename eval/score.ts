// Pure scoring for the extraction eval. No I/O, so it is unit-tested in score.test.ts.
import type { ExtractionResult, ItemKind } from "../src/lib/types";

export interface ExpectedItem {
  kind: ItemKind;
  text: string;
  /** The other person. A list means any of these is fine (null in the list allows no person). */
  person: string | null | Array<string | null>;
}

export interface Expected {
  newItems: ExpectedItem[];
  closes: string[];
  /** Items a careful human might or might not list: matching one is neither a hit nor wrong. */
  optionalItems?: ExpectedItem[];
  /** Open item ids that may or may not be closed: closing one is neither a hit nor wrong. */
  optionalCloses?: string[];
}

export interface ItemMatch {
  expected: ExpectedItem;
  actual: ExtractionResult["newItems"][number];
}

export interface MeetingScore {
  correct: ItemMatch[];
  missed: ExpectedItem[];
  wrong: ExtractionResult["newItems"];
  /** Actual items that matched an optional expected item (not counted). */
  optional: ItemMatch[];
  correctCloses: string[];
  /** Closes of optional ids (not counted). */
  optionalCloses: string[];
  wrongCloses: string[];
  missedCloses: string[];
}

const STOPWORDS = new Set(
  "a an the to of for and or in on at by with from about into is are be it this that their them his her our my your up as".split(" "),
);

/** Generic verbs that start item text; they don't identify what the item is about. */
const GENERIC_VERBS = new Set(
  "send share check review update fix make do get give follow ask tell confirm finish complete create add write call set look prepare push merge ship move test go use put build run".split(
    " ",
  ),
);

function stem(t: string): string {
  if (t.length > 7 && t.endsWith("ation")) return t.slice(0, -5); // "confirmation" ~ "confirm"
  if (t.length > 5 && t.endsWith("ing")) return t.slice(0, -3);
  if (t.length > 4 && t.endsWith("ed") && !t.endsWith("eed")) return t.slice(0, -2);
  if (t.length > 4 && t.endsWith("ies")) return t.slice(0, -3) + "y";
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

export function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/([a-z0-9])-(?=[a-z0-9])/g, "$1") // "front-end" ~ "frontend"
    .split(/[^a-z0-9']+/)
    .map((t) => t.replace(/'s$/, "").replace(/'/g, ""))
    .filter((t) => t && !STOPWORDS.has(t))
    .map(stem);
}

/** Dice coefficient over content tokens: 2|A∩B| / (|A|+|B|). */
export function tokenOverlap(a: string, b: string): number {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (A.size === 0 && B.size === 0) return 1;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return (2 * shared) / (A.size + B.size);
}

/**
 * The "key noun" of an item text: the longest content token that isn't a generic verb or a
 * person's name. "Send Nitin the final banner text" with person Nitin -> "banner".
 */
export function keyNoun(text: string, person: ExpectedItem["person"]): string | null {
  const names = new Set(personList(person).flatMap((p) => (p ? tokens(p) : [])));
  const candidates = tokens(text).filter((t) => !GENERIC_VERBS.has(t) && !names.has(t) && t.length >= 3);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, t) => (t.length > best.length ? t : best));
}

export function textMatches(expected: ExpectedItem, actualText: string): boolean {
  if (tokenOverlap(expected.text, actualText) >= 0.5) return true;
  const key = keyNoun(expected.text, expected.person);
  return key !== null && tokens(actualText).includes(key);
}

/** Person names match when equal ignoring case, or one is a prefix/word of the other ("Nitin" ~ "Nitin K"). */
export function personMatches(expected: string | null, actual: string | null): boolean {
  const e = (expected ?? "").trim().toLowerCase();
  const a = (actual ?? "").trim().toLowerCase();
  if (!e || !a) return !e && !a;
  if (e === a) return true;
  const ew = e.split(/\s+/);
  const aw = a.split(/\s+/);
  if (ew[0] === aw[0]) return true;
  if (ew.some((w) => aw.includes(w) && w.length >= 3)) return true;
  // small typos in transcribed names: "Nithin" vs "Nitin"
  return ew[0].length >= 4 && aw[0].length >= 4 && editDistance(ew[0], aw[0]) <= 1;
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

function personList(p: ExpectedItem["person"]): Array<string | null> {
  return Array.isArray(p) ? p : [p];
}

/** Decisions carry no person, so person is not compared for them. */
export function itemMatches(expected: ExpectedItem, actual: ExtractionResult["newItems"][number]): boolean {
  if (expected.kind !== actual.kind) return false;
  if (expected.kind !== "decision" && !personList(expected.person).some((p) => personMatches(p, actual.person)))
    return false;
  return textMatches(expected, actual.text);
}

/**
 * One-to-one matching, best pairs first: every (expected, actual) pair that matches is ranked by text
 * overlap and taken greedily, so a loose key-noun match can't take an actual item that another
 * expected item matches better.
 */
function matchAll(
  expected: ExpectedItem[],
  actual: ExtractionResult["newItems"],
  used: Set<number>,
): { matched: ItemMatch[]; unmatched: ExpectedItem[] } {
  const pairs: Array<{ e: number; a: number; s: number }> = [];
  expected.forEach((e, ei) =>
    actual.forEach((a, ai) => {
      if (!used.has(ai) && itemMatches(e, a)) pairs.push({ e: ei, a: ai, s: tokenOverlap(e.text, a.text) });
    }),
  );
  pairs.sort((x, y) => y.s - x.s || x.e - y.e || x.a - y.a);
  const takenE = new Map<number, number>();
  for (const p of pairs) {
    if (takenE.has(p.e) || used.has(p.a)) continue;
    takenE.set(p.e, p.a);
    used.add(p.a);
  }
  const matched: ItemMatch[] = [];
  const unmatched: ExpectedItem[] = [];
  expected.forEach((e, ei) => {
    const ai = takenE.get(ei);
    if (ai === undefined) unmatched.push(e);
    else matched.push({ expected: e, actual: actual[ai] });
  });
  return { matched, unmatched };
}

export function scoreMeeting(expected: Expected, actual: Pick<ExtractionResult, "newItems" | "closes">): MeetingScore {
  const used = new Set<number>();
  // Required and optional items compete in one ranking, so an actual item goes to the expected item it fits best.
  const required = new Set(expected.newItems);
  const all = matchAll([...expected.newItems, ...(expected.optionalItems ?? [])], actual.newItems, used);
  const correct = all.matched.filter((m) => required.has(m.expected));
  const optional = all.matched.filter((m) => !required.has(m.expected));
  const missed = all.unmatched.filter((e) => required.has(e));
  const wrong = actual.newItems.filter((_, i) => !used.has(i));

  const expectedCloses = new Set(expected.closes);
  const optionalIds = new Set((expected.optionalCloses ?? []).filter((id) => !expectedCloses.has(id)));
  const actualCloses = new Set(actual.closes.map((c) => c.itemId));
  return {
    correct,
    missed,
    wrong,
    optional,
    correctCloses: [...actualCloses].filter((id) => expectedCloses.has(id)),
    optionalCloses: [...actualCloses].filter((id) => optionalIds.has(id)),
    wrongCloses: [...actualCloses].filter((id) => !expectedCloses.has(id) && !optionalIds.has(id)),
    missedCloses: [...expectedCloses].filter((id) => !actualCloses.has(id)),
  };
}

export interface Totals {
  correct: number;
  missed: number;
  wrong: number;
  correctCloses: number;
  wrongCloses: number;
  missedCloses: number;
  /** Over items and closes together. 1 when nothing was predicted. */
  precision: number;
  /** Over items and closes together. 1 when nothing was expected. */
  recall: number;
  /** Items only. */
  itemPrecision: number;
  itemRecall: number;
  /** Closes only. */
  closePrecision: number;
  closeRecall: number;
}

const ratio = (hits: number, total: number) => (total === 0 ? 1 : hits / total);

export function totals(scores: MeetingScore[]): Totals {
  const sum = (f: (s: MeetingScore) => number) => scores.reduce((n, s) => n + f(s), 0);
  const t = {
    correct: sum((s) => s.correct.length),
    missed: sum((s) => s.missed.length),
    wrong: sum((s) => s.wrong.length),
    correctCloses: sum((s) => s.correctCloses.length),
    wrongCloses: sum((s) => s.wrongCloses.length),
    missedCloses: sum((s) => s.missedCloses.length),
  };
  const hits = t.correct + t.correctCloses;
  return {
    ...t,
    precision: ratio(hits, hits + t.wrong + t.wrongCloses),
    recall: ratio(hits, hits + t.missed + t.missedCloses),
    itemPrecision: ratio(t.correct, t.correct + t.wrong),
    itemRecall: ratio(t.correct, t.correct + t.missed),
    closePrecision: ratio(t.correctCloses, t.correctCloses + t.wrongCloses),
    closeRecall: ratio(t.correctCloses, t.correctCloses + t.missedCloses),
  };
}

export const THRESHOLD = { precision: 0.9, recall: 0.9 };

export function passes(t: Totals): boolean {
  return t.precision >= THRESHOLD.precision && t.recall >= THRESHOLD.recall;
}
