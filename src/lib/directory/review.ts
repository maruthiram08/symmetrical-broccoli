// "Check names": the names on items that nobody has confirmed yet, where each one appears, and
// the people it most likely means. Pure.

import { belongsTo, groupNames, normalizeName, type PersonGroup } from "@/lib/people";
import type { Item, Meeting } from "@/lib/types";
import type { Person } from "./directory";
import { foldLetters, keySimilarity, nameKey as soundOf, soundKey, spellingSimilarity } from "./phonetic";

export interface Suggestion {
  name: string;
  /** Set when the suggestion is a confirmed person; otherwise another unchecked name. */
  personId?: string;
  /** Spellings to merge along with it (an unchecked name's own spellings). */
  spellings: string[];
  score: number;
  /** Why it is suggested: "sounds alike", "similar spelling", "same first name", "in 2 of the same meetings". */
  why: string[];
}

export interface NameToCheck {
  /** Stable id for the page: the group's slug. */
  key: string;
  name: string;
  spellings: string[];
  items: number;
  meetings: number;
  lastSeenAt: string | null;
  /** The newest item's quote and meeting, to judge who it is. */
  quote: { text: string; meeting: string | null; item: string } | null;
  suggestions: Suggestion[];
}

export interface ReviewInput {
  /** Items as read through the directory (person resolved, personId set on known ones). */
  items: Item[];
  meetings: Meeting[];
  /** Confirmed people. */
  people: Person[];
  self?: string[];
}

const live = (i: Item) => i.status !== "wrong";

/** Names on live items that the directory doesn't know: most items first, then newest. */
export function namesToCheck({ items, meetings, people, self = [] }: ReviewInput, maxSuggestions = 3): NameToCheck[] {
  const unknown = items.filter((i) => live(i) && i.person && !i.personId);
  const groups = groupNames(unknown.map((i) => i.person!), self);
  const byId = new Map(meetings.map((m) => [m.id, m]));
  const startOf = (i: Item) => byId.get(i.meetingId)?.startedAt ?? i.createdAt;

  const facts = groups.map((g) => {
    const theirs = unknown.filter((i) => belongsTo(g, i.person) && g.keys.includes(normalizeName(i.person!)));
    const meetingIds = new Set(theirs.map((i) => i.meetingId).filter((id) => byId.has(id)));
    const newest = [...theirs].sort((a, b) => startOf(b).localeCompare(startOf(a)))[0];
    return { g, theirs, meetingIds, newest };
  });

  // Where each candidate shows up, for co-occurrence: meetings they're in or named on.
  const live_ = items.filter(live);
  const confirmedCands = people.filter((p) => p.status === "confirmed").map((p) => {
    const keys = [p.name, ...p.aliases].map(normalizeName);
    const g: PersonGroup = { name: p.name, slug: "", keys, spellings: [p.name, ...p.aliases], personId: p.id };
    const ids = new Set<string>([
      ...live_.filter((i) => i.personId === p.id).map((i) => i.meetingId),
      ...meetings.filter((m) => m.participants.some((x) => belongsTo(g, x))).map((m) => m.id),
    ]);
    return { name: p.name, personId: p.id, spellings: [p.name, ...p.aliases], meetingIds: ids, weight: Infinity };
  });

  return facts
    .map(({ g, theirs, meetingIds, newest }) => {
      const others = facts
        .filter((f) => f.g !== g)
        .map((f) => ({
          name: f.g.name, spellings: f.g.spellings,
          meetingIds: new Set([...f.meetingIds, ...meetings.filter((m) => m.participants.some((x) => belongsTo(f.g, x))).map((m) => m.id)]),
          weight: f.theirs.length,
        }));
      const suggestions = rankMatches(g.name, meetingIds, [...confirmedCands, ...others], theirs.length).slice(0, maxSuggestions);
      const m = newest ? byId.get(newest.meetingId) : undefined;
      return {
        key: g.slug,
        name: g.name,
        spellings: g.spellings,
        items: theirs.length,
        meetings: meetingIds.size,
        lastSeenAt: newest ? startOf(newest) : null,
        quote: newest ? { text: newest.quote || newest.text, meeting: m ? m.title : null, item: newest.text } : null,
        suggestions,
      };
    })
    .sort((a, b) => b.items - a.items || (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? "") || a.name.localeCompare(b.name));
}

export interface Candidate {
  name: string;
  personId?: string;
  spellings: string[];
  /** Meetings the candidate is in or named on. */
  meetingIds: Set<string>;
  /** Items under the candidate (Infinity for a confirmed person): an unchecked name is only suggested for a smaller one. */
  weight?: number;
}

const MIN_SCORE = 0.42;

/**
 * Rank candidates for a name: sound-alike keys (50%), spelling (25%), same first name (15%) and
 * shared meetings (10%). A confirmed person gets a small edge over another unchecked name.
 */
export function rankMatches(name: string, meetingIds: Set<string>, candidates: Candidate[], ownWeight = 0): Suggestion[] {
  const out: Suggestion[] = [];
  for (const c of candidates) {
    if (c.weight !== undefined && c.weight < ownWeight) continue;
    let best = { score: 0, why: [] as string[] };
    for (const spelling of c.spellings) {
      const s = scorePair(name, spelling);
      if (s.score > best.score) best = s;
    }
    const shared = [...meetingIds].filter((id) => c.meetingIds.has(id)).length;
    const cooc = meetingIds.size ? shared / meetingIds.size : 0;
    let score = best.score + 0.1 * cooc + (c.personId ? 0.03 : 0);
    if (best.score < 0.3) score = 0; // sharing a meeting alone is no reason
    const why = [...best.why, ...(shared ? [`in ${shared} of the same meeting${shared === 1 ? "" : "s"}`] : [])];
    if (score >= MIN_SCORE) out.push({ name: c.name, ...(c.personId ? { personId: c.personId } : {}), spellings: c.spellings, score: Math.round(score * 100) / 100, why });
  }
  return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).filter((s, i, xs) => xs.findIndex((x) => x.name === s.name) === i);
}

/** How alike two names are, before meetings are counted (0..0.9). */
export function scorePair(a: string, b: string): { score: number; why: string[] } {
  const ta = normalizeName(a).split(" ").filter(Boolean);
  const tb = normalizeName(b).split(" ").filter(Boolean);
  if (!ta.length || !tb.length) return { score: 0, why: [] };
  const full = keySimilarity(soundOf(ta.join(" ")).replace(/ /g, ""), soundOf(tb.join(" ")).replace(/ /g, ""));
  const first = keySimilarity(soundKey(ta[0]), soundKey(tb[0]));
  // "Nithin" vs "Nitin Kumar": one side is just a first name, so compare first names.
  const phon = ta.length === 1 || tb.length === 1 ? Math.max(full, 0.92 * first) : Math.max(full, 0.8 * first);
  const spell = Math.max(spellingSimilarity(ta.join(""), tb.join("")), ta.length === 1 || tb.length === 1 ? 0.9 * spellingSimilarity(ta[0], tb[0]) : 0);
  const sameFirst = foldLetters(ta[0]) === foldLetters(tb[0]) ? 1 : 0;
  const score = 0.5 * phon + 0.25 * spell + 0.15 * sameFirst;
  const why: string[] = [];
  if (phon >= 0.8) why.push("sounds alike");
  if (spell >= 0.6 && !sameFirst) why.push("similar spelling");
  if (sameFirst) why.push("same first name");
  return { score, why };
}

/** Speaker labels hidden from Check names ("Speaker 5": 3 items), most items first. */
export function unlabelledSpeakers(items: Item[]): Array<{ label: string; items: number }> {
  const counts = new Map<string, { label: string; items: number }>();
  for (const i of items) {
    if (!live(i) || !i.unattributed || !i.personRaw) continue;
    const k = normalizeName(i.personRaw);
    const c = counts.get(k) ?? { label: i.personRaw.trim(), items: 0 };
    c.items++;
    counts.set(k, c);
  }
  return [...counts.values()].sort((a, b) => b.items - a.items || a.label.localeCompare(b.label, undefined, { numeric: true }));
}
