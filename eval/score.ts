// Pure scoring for the extraction eval. No I/O, so it is unit-tested in score.test.ts.
import type { ExtractionResult, ItemKind } from "../src/lib/types";
import { soundKey, spellingSimilarity } from "../src/lib/directory/phonetic";

export interface ExpectedItem {
  kind: ItemKind;
  /** A list gives other fair phrasings: matching any of them counts. */
  text: string | string[];
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

/** The expected item's phrasings. */
export function textsOf(e: Pick<ExpectedItem, "text">): string[] {
  return Array.isArray(e.text) ? e.text : [e.text];
}

/** How much of the shorter text the longer one covers, in content words other than generic verbs: |A∩B| / min(|A|,|B|). */
function containment(a: string, b: string): { shared: number; ratio: number } {
  const words = (x: string) => new Set(tokens(x).filter((t) => !GENERIC_VERBS.has(t)));
  const A = words(a);
  const B = words(b);
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return { shared, ratio: A.size && B.size ? shared / Math.min(A.size, B.size) : 0 };
}

/** Best text overlap of the expected item's phrasings with an actual text. */
export function expectedOverlap(e: Pick<ExpectedItem, "text">, actualText: string): number {
  return Math.max(...textsOf(e).map((t) => tokenOverlap(t, actualText)));
}

/**
 * Text match for one phrasing: Dice overlap of at least 0.5; or at least 2 shared content words
 * (not counting generic verbs) covering 60% of the shorter text ("Check Mangku's message on the dividend tag" ~ "Check the
 * dividend tag"); or the expected key noun appears in the actual text.
 */
function phrasingMatches(text: string, person: ExpectedItem["person"], actualText: string): boolean {
  if (tokenOverlap(text, actualText) >= 0.5) return true;
  const c = containment(text, actualText);
  if (c.shared >= 2 && c.ratio >= 0.6) return true;
  const key = keyNoun(text, person);
  return key !== null && tokens(actualText).includes(key);
}

export function textMatches(expected: ExpectedItem, actualText: string): boolean {
  return textsOf(expected).some((t) => phrasingMatches(t, expected.person, actualText));
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
  if (ew[0].length >= 4 && aw[0].length >= 4 && editDistance(ew[0], aw[0]) <= 1) return true;
  // sound-alike spellings ("Hashmit" ~ "Hashmeet"), with close letters so "Nitin" !~ "Nathan"
  const ke = soundKey(ew[0]);
  return ke.length >= 3 && ke === soundKey(aw[0]) && spellingSimilarity(ew[0], aw[0]) >= 0.6;
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
      if (!used.has(ai) && itemMatches(e, a)) pairs.push({ e: ei, a: ai, s: expectedOverlap(e, a.text) });
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

// ---------- attribution ----------

type ActualItem = ExtractionResult["newItems"][number];

export interface AttributionMatch {
  expected: ExpectedItem;
  actual: ActualItem;
  /** Same kind (owe vs waiting) and an acceptable person. */
  correct: boolean;
}

const isPromise = (k: ItemKind) => k === "owe" || k === "waiting";

function personOk(expected: ExpectedItem, actual: ActualItem): boolean {
  return personList(expected.person).some((p) => personMatches(p, actual.person));
}

/**
 * Attribution: who made each promise. Required owe/waiting items are matched to actual owe/waiting
 * items on text alone (kind and person ignored), one-to-one. Pairs that also have the right kind and
 * person go first, so a correct item is never paired with a lookalike. A match is correct when the
 * kind and the person are right; "Send Asha the deck" recorded as waiting on Asha is wrong.
 */
export function attributionScore(expected: Expected, actual: Pick<ExtractionResult, "newItems">): AttributionMatch[] {
  const exp = expected.newItems.filter((e) => isPromise(e.kind));
  const act = actual.newItems.filter((a) => isPromise(a.kind));
  const pairs: Array<{ e: number; a: number; s: number }> = [];
  exp.forEach((e, ei) =>
    act.forEach((a, ai) => {
      if (!textMatches(e, a.text)) return;
      const correct = e.kind === a.kind && personOk(e, a);
      pairs.push({ e: ei, a: ai, s: (correct ? 1 : 0) + expectedOverlap(e, a.text) });
    }),
  );
  pairs.sort((x, y) => y.s - x.s || x.e - y.e || x.a - y.a);
  const usedE = new Set<number>();
  const usedA = new Set<number>();
  const out: AttributionMatch[] = [];
  for (const p of pairs) {
    if (usedE.has(p.e) || usedA.has(p.a)) continue;
    usedE.add(p.e);
    usedA.add(p.a);
    const e = exp[p.e];
    const a = act[p.a];
    out.push({ expected: e, actual: a, correct: e.kind === a.kind && personOk(e, a) });
  }
  return out;
}

export interface AttributionTotals {
  matched: number;
  correct: number;
  accuracy: number;
  /** By the model's own attribution field: "label", "content", or "none" when it left it out. */
  bySource: Record<"label" | "content" | "none", { matched: number; correct: number }>;
}

export function attributionTotals(matches: AttributionMatch[]): AttributionTotals {
  const bySource: AttributionTotals["bySource"] = {
    label: { matched: 0, correct: 0 },
    content: { matched: 0, correct: 0 },
    none: { matched: 0, correct: 0 },
  };
  for (const m of matches) {
    const b = bySource[m.actual.attribution ?? "none"];
    b.matched++;
    if (m.correct) b.correct++;
  }
  const correct = matches.filter((m) => m.correct).length;
  return { matched: matches.length, correct, accuracy: ratio(correct, matches.length), bySource };
}

// ---------- stability across repeated reads ----------

/** Two actual items from different reads of one meeting are the same item. */
export function sameItem(a: ActualItem, b: ActualItem): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind !== "decision" && !personMatches(a.person, b.person)) return false;
  if (tokenOverlap(a.text, b.text) >= 0.5) return true;
  const ka = keyNoun(a.text, a.person);
  const kb = keyNoun(b.text, b.person);
  return (ka !== null && tokens(b.text).includes(ka)) || (kb !== null && tokens(a.text).includes(kb));
}

export interface Overlap {
  a: number;
  b: number;
  matched: number;
  /** Items in either read: a + b - matched. */
  union: number;
  /** matched / union (Jaccard); 1 when both reads are empty. */
  ratio: number;
  onlyA: ActualItem[];
  onlyB: ActualItem[];
}

/** One-to-one overlap of two reads' items of the given kinds, best pairs first. */
export function overlap(a: ActualItem[], b: ActualItem[], kinds: ItemKind[]): Overlap {
  const A = a.filter((i) => kinds.includes(i.kind));
  const B = b.filter((i) => kinds.includes(i.kind));
  const pairs: Array<{ x: number; y: number; s: number }> = [];
  A.forEach((x, xi) => B.forEach((y, yi) => sameItem(x, y) && pairs.push({ x: xi, y: yi, s: tokenOverlap(x.text, y.text) })));
  pairs.sort((p, q) => q.s - p.s || p.x - q.x || p.y - q.y);
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  for (const p of pairs) {
    if (usedA.has(p.x) || usedB.has(p.y)) continue;
    usedA.add(p.x);
    usedB.add(p.y);
  }
  const matched = usedA.size;
  const union = A.length + B.length - matched;
  return {
    a: A.length,
    b: B.length,
    matched,
    union,
    ratio: ratio(matched, union),
    onlyA: A.filter((_, i) => !usedA.has(i)),
    onlyB: B.filter((_, i) => !usedB.has(i)),
  };
}

/** Pooled overlap over meetings (and read pairs): sum matched / sum union. */
export function overlapTotals(os: Overlap[]): { matched: number; union: number; ratio: number } {
  const matched = os.reduce((n, o) => n + o.matched, 0);
  const union = os.reduce((n, o) => n + o.union, 0);
  return { matched, union, ratio: ratio(matched, union) };
}

// ---------- scoring one kind only ----------

export type Only = "decisions" | "owe" | "waiting" | "items" | "closes";
export const ONLY_VALUES: Only[] = ["decisions", "owe", "waiting", "items", "closes"];

/** Restricts expected and actual to one kind of thing, so a run can be read for that kind alone. */
export function restrict<A extends Pick<ExtractionResult, "newItems" | "closes">>(
  only: Only | null,
  expected: Expected,
  actual: A,
): { expected: Expected; actual: A } {
  if (!only) return { expected, actual };
  const keep = (k: ItemKind) =>
    only === "items" ? true : only === "closes" ? false : only === "decisions" ? k === "decision" : k === only;
  const items = only !== "closes";
  const closes = only === "closes";
  return {
    expected: {
      newItems: expected.newItems.filter((i) => keep(i.kind)),
      optionalItems: expected.optionalItems?.filter((i) => keep(i.kind)),
      closes: closes ? expected.closes : [],
      optionalCloses: closes ? expected.optionalCloses : [],
    },
    actual: { ...actual, newItems: items ? actual.newItems.filter((i) => keep(i.kind)) : [], closes: closes ? actual.closes : [] },
  };
}

// ---------- near misses ----------

export interface NearMiss {
  expected: ExpectedItem;
  actual: ActualItem;
  /** What differs: "kind", "person" and/or "text". */
  differs: string[];
  overlap: number;
}

/**
 * For each missed item, the closest wrong item (by text overlap, at least one shared word), and
 * what keeps them from matching. For reading misses: a fair paraphrase shows up here with
 * differs ["text"], and can be added to the fixture as another phrasing.
 */
export function nearMisses(score: Pick<MeetingScore, "missed" | "wrong">): NearMiss[] {
  const out: NearMiss[] = [];
  for (const e of score.missed) {
    let best: NearMiss | null = null;
    for (const a of score.wrong) {
      const o = expectedOverlap(e, a.text);
      if (o === 0 || (best && best.overlap >= o)) continue;
      const differs = [
        ...(e.kind !== a.kind ? ["kind"] : []),
        ...(e.kind !== "decision" && !personList(e.person).some((p) => personMatches(p, a.person)) ? ["person"] : []),
        ...(!textMatches(e, a.text) ? ["text"] : []),
      ];
      best = { expected: e, actual: a, differs, overlap: o };
    }
    if (best) out.push(best);
  }
  return out;
}
