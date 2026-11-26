// Filing items into projects without asking: each item (not each meeting, since one meeting can
// cover several projects) is scored against every project, and filed only when one project clearly
// wins. Anything unsure stays unfiled, for "Needs a project". No AI call: it runs on every read.
//
// What a project is known by:
//  - its title and its `keywords` property (seeds, full strength);
//  - what you filed there yourself (learned): the words of those items and their meetings' titles,
//    weighed by how much a word belongs to this project rather than to all of them;
//  - what you took out of it (a correction lowers those words for that project).
import { pairs, words } from "@/lib/canvas/text";

export interface ProjectInfo {
  slug: string;
  title: string;
  /** Extra words or phrases that mean this project ("stock split", "dividend"). */
  keywords: string[];
}

/** One thing you filed (or took out) by hand. Kept outside the items, so a re-read keeps them. */
export interface FilingExample {
  /** The item it came from, so a later change replaces it. */
  itemId: string;
  text: string;
  /** The item's meeting title, when it had one. */
  title?: string;
  person?: string | null;
  /** Where you put it; null when you said it belongs to no project. */
  project: string | null;
  /** Projects you said it isn't (you took it out of an automatic filing). */
  not?: string[];
  at: string;
}

export interface Candidate {
  id: string;
  text: string;
  /** Its meeting's title. */
  title?: string;
  person?: string | null;
}

export interface Verdict {
  project: string | null;
  /** Shown beside an automatic filing: `matched "stock split"`. */
  why: string | null;
  score: number;
  /** The runner-up, for tests and the log. */
  second?: { project: string; score: number };
}

/** A filing needs this score, and to beat the runner-up by MARGIN times. Tuned on real meetings. */
export const THRESHOLD = 1;
export const MARGIN = 1.5;
/** A meeting title alone counts this much of an item's own words. */
const TITLE_WEIGHT = 0.6;
const PERSON_WEIGHT = 0.4;
const PAIR_WEIGHT = 1.6;
/** An item's own words this strong for some project switch off the meeting title. */
const OWN_CLEAR = 0.25;

const terms = (s: string) => [...new Set([...words(s), ...pairs(s)])];
const personKey = (p: string) => `@${p.trim().toLowerCase()}`;

export interface Model {
  projects: ProjectInfo[];
  /** project → term → strength 0..1 */
  strength: Map<string, Map<string, number>>;
  /** project → its seeds as typed (title, keywords), lowercase: matched as whole phrases. */
  phrases: Map<string, Set<string>>;
  /** term → 0..1, lower for words in many items ("share", "ticket"). */
  rarity: (t: string) => number;
}

/**
 * Learn the projects from their seeds and your examples. `corpus` is every item's text (for word
 * rarity); examples whose project is gone are ignored.
 */
export function buildModel(projects: ProjectInfo[], examples: FilingExample[], corpus: string[]): Model {
  const df = new Map<string, number>();
  for (const s of corpus) for (const t of terms(s)) df.set(t, (df.get(t) ?? 0) + 1);
  const n = Math.max(corpus.length, 1);
  const maxIdf = Math.log(n + 1);
  const rarity = (t: string) => {
    if (t.startsWith("@")) return 1;
    const d = df.get(t) ?? 0;
    // Pairs are specific by nature; single words in a fifth of everything say little.
    const r = Math.log((n + 1) / (d + 1)) / maxIdf;
    return Math.max(0.15, Math.min(1, t.includes(" ") ? r + 0.3 : r));
  };

  const live = new Set(projects.map((p) => p.slug));
  // Counts of a term among filed examples: per project, overall, and against (taken out).
  const inP = new Map<string, Map<string, number>>();
  const all = new Map<string, number>();
  const against = new Map<string, Map<string, number>>();
  const bump = (m: Map<string, Map<string, number>>, p: string, t: string, by = 1) => {
    const x = m.get(p) ?? m.set(p, new Map()).get(p)!;
    x.set(t, (x.get(t) ?? 0) + by);
  };
  for (const e of examples) {
    const ts = new Set([...terms(e.text), ...terms(e.title ?? "").map((t) => `~${t}`), ...(e.person ? [personKey(e.person)] : [])]);
    for (const t of ts) {
      all.set(t, (all.get(t) ?? 0) + 1);
      if (e.project && live.has(e.project)) bump(inP, e.project, t);
      for (const p of e.not ?? []) if (live.has(p)) bump(against, p, t);
    }
  }

  const strength = new Map<string, Map<string, number>>();
  const phrases = new Map<string, Set<string>>();
  for (const p of projects) {
    const s = new Map<string, number>();
    phrases.set(p.slug, new Set([p.title, ...p.keywords].map((k) => [...words(k)].join(" ")).filter(Boolean)));
    // Seeds: the title and keywords, as words and as phrases, at full strength.
    for (const k of [p.title, ...p.keywords]) {
      for (const t of terms(k)) { s.set(t, 1); s.set(`~${t}`, 1); }
    }
    // Learned: the share of your filed examples with this term that are in this project, minus
    // what you took out of it.
    for (const [t, c] of inP.get(p.slug) ?? []) {
      const share = c / ((all.get(t) ?? c) + 0.5);
      // A single word ("split", "trading") needs two examples; a phrase or a person counts from one.
      const single = !t.startsWith("@") && !t.includes(" ");
      if (single && c < 2) continue;
      const learned = share * Math.min(1, single ? (c + 1) / 3 : 1);
      s.set(t, Math.max(s.get(t) ?? 0, learned));
    }
    for (const [t, c] of against.get(p.slug) ?? []) {
      const v = (s.get(t) ?? 0) - Math.min(1, c / 2) * 0.8;
      if (v > 0) s.set(t, v); else s.delete(t);
    }
    strength.set(p.slug, s);
  }
  return { projects, strength, phrases, rarity };
}

/** Score one item against every project and decide. */
export function judge(c: Candidate, m: Model): Verdict {
  const own = terms(c.text);
  const title = terms(c.title ?? "");
  const per = m.projects.map((p) => {
    const s = m.strength.get(p.slug)!;
    const phrases = m.phrases.get(p.slug)!;
    const val = (t: string, key: string) => {
      // A whole seed (a one-word project name or keyword) counts like a phrase, however common.
      const whole = phrases.has(key.replace(/^~/, ""));
      const r = whole ? Math.max(m.rarity(t), 0.8) : m.rarity(t);
      return (s.get(key) ?? 0) * r * (t.includes(" ") || whole ? PAIR_WEIGHT : 1);
    };
    let ownScore = 0;
    let best: { t: string; v: number } | null = null;
    for (const t of own) {
      const v = val(t, t);
      if (v <= 0) continue;
      ownScore += v;
      if (!best || v > best.v) best = { t, v };
    }
    let titleScore = 0;
    // The meeting title: what you learned from titles, else the item's own-word strengths.
    for (const t of title) titleScore += Math.max(0, val(t, s.has(`~${t}`) ? `~${t}` : t));
    const person = c.person ? Math.max(0, (s.get(personKey(c.person)) ?? 0) * PERSON_WEIGHT) : 0;
    return { slug: p.slug, ownScore, titleScore, person, best: best as { t: string; v: number } | null };
  });
  // Meetings wander: the title only helps when the item's own words don't point at another project.
  const ownMax = Math.max(0, ...per.map((x) => x.ownScore));
  const scored = per
    .map((x) => ({ ...x, score: x.ownScore + x.person + (x.ownScore > 0 || ownMax < OWN_CLEAR ? x.titleScore * TITLE_WEIGHT : 0) }))
    .sort((a, b) => b.score - a.score);

  const [a, b] = scored;
  const second = b && b.score > 0 ? { project: b.slug, score: round(b.score) } : undefined;
  if (!a || a.score < THRESHOLD || (b && a.score < b.score * MARGIN)) return { project: null, why: null, score: round(a?.score ?? 0), ...(second ? { second } : {}) };
  const why = a.best && a.best.v >= 0.3 ? `matched “${a.best.t}”`
    : a.titleScore * TITLE_WEIGHT >= a.person ? `from the meeting “${clipTitle(c.title ?? "")}”`
    : `usually with ${c.person}`;
  return { project: a.slug, why, score: round(a.score), ...(second ? { second } : {}) };
}

const clipTitle = (t: string) => (t.length > 40 ? `${t.slice(0, 39).trimEnd()}…` : t);

const round = (x: number) => Math.round(x * 100) / 100;

/** A `keywords` property as a list: a YAML list or "a, b; c". */
export function keywordList(v: unknown): string[] {
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,;]/) : [];
  return raw.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean);
}

/** Projects marked done or archived get nothing new. */
export function isClosedProject(status: unknown): boolean {
  return typeof status === "string" && /^(done|archived|closed|complete|completed|dropped|cancelled|canceled)$/i.test(status.trim());
}

/** Add or replace the example for an item. Newest last, at most `max`. */
export function upsertExample(list: FilingExample[], e: FilingExample, max = 3000): FilingExample[] {
  const prev = list.find((x) => x.itemId === e.itemId);
  const not = [...new Set([...(prev?.not ?? []), ...(e.not ?? [])])].filter((p) => p !== e.project);
  const next = { ...e, ...(not.length ? { not } : {}) };
  if (!not.length) delete next.not;
  return [...list.filter((x) => x.itemId !== e.itemId), next].slice(-max);
}
