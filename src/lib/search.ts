// Search over items (open and closed) and meetings. Pure and in memory: a linear scan over
// precomputed lowercase text is well under a millisecond per thousand items.

import type { Item, ItemKind, ItemStatus, Meeting } from "@/lib/types";

/** Lowercase, punctuation to spaces, padded with spaces so " word" finds word starts. */
export function fold(s: string): string {
  return " " + s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim() + " ";
}

/** Query words, lowercase, deduped, in order. */
export function terms(q: string): string[] {
  return [...new Set(fold(q).trim().split(" ").filter(Boolean))];
}

export type SearchHit =
  | {
      type: "item"; id: string; kind: ItemKind; status: ItemStatus;
      text: string; quote: string; closeQuote: string | null; person: string | null;
      meetingId: string; meetingTitle: string; at: string; score: number;
    }
  | { type: "meeting"; id: string; title: string; participants: string[]; at: string; score: number };

/** `hay` is the thing itself; `ctx` is around it (an item's meeting title, a meeting's people). */
interface Doc { hit: SearchHit; hay: string; ctx: string }

export interface SearchIndex { docs: Doc[] }

/** Build once per request; `search` can then run many times. Items marked wrong are left out. */
export function buildIndex(items: Item[], meetings: Meeting[]): SearchIndex {
  const byId = new Map(meetings.map((m) => [m.id, m]));
  const docs: Doc[] = [];
  for (const i of items) {
    if (i.status === "wrong") continue;
    const m = byId.get(i.meetingId);
    const title = m?.title ?? "";
    docs.push({
      hit: {
        type: "item", id: i.id, kind: i.kind, status: i.status, text: i.text, quote: i.quote,
        closeQuote: i.closeQuote, person: i.person, meetingId: i.meetingId, meetingTitle: title,
        at: m?.startedAt ?? i.createdAt, score: 0,
      },
      // fields joined with a separator so a phrase never spans two of them
      hay: [i.text, i.quote, i.closeQuote ?? "", i.person ?? "", i.personRaw ?? ""].map(fold).join("\u0000"),
      ctx: fold(title),
    });
  }
  for (const m of meetings) {
    docs.push({
      hit: { type: "meeting", id: m.id, title: m.title, participants: m.participants, at: m.startedAt, score: 0 },
      hay: fold(m.title),
      ctx: m.participants.map(fold).join("\u0000"),
    });
  }
  return { docs };
}

/**
 * Rank: exact phrase (3) > all words (2) > some words (1, more words first); newest first on ties.
 * Within a tier, a match in the thing itself beats one only in its context.
 * Words match at word starts, so "ban" finds "banner".
 */
export function search(index: SearchIndex, q: string, limit = 50): SearchHit[] {
  const ws = terms(q);
  if (!ws.length) return [];
  const phrase = " " + ws.join(" ");
  const scored: SearchHit[] = [];
  for (const d of index.docs) {
    let n = 0;
    let own = 0;
    for (const w of ws) {
      const inOwn = d.hay.includes(" " + w);
      if (inOwn) own++;
      if (inOwn || d.ctx.includes(" " + w)) n++;
    }
    if (!n) continue;
    const exact = ws.length > 1 && (d.hay.includes(phrase) || d.ctx.includes(phrase));
    const tier = n === ws.length ? (exact ? 3 : 2) : 1;
    scored.push({ ...d.hit, score: tier * 1000 + n * 10 + (own === n ? 1 : 0) });
  }
  scored.sort((a, b) => b.score - a.score || b.at.localeCompare(a.at));
  return scored.slice(0, limit);
}

export interface Segment { text: string; hit: boolean }

/** Split text into plain and matched runs, matching each query word at word starts. */
export function highlight(text: string, q: string | string[]): Segment[] {
  const ws = (Array.isArray(q) ? q : terms(q)).filter(Boolean);
  if (!ws.length || !text) return text ? [{ text, hit: false }] : [];
  const lower = text.toLowerCase();
  const marks = new Uint8Array(text.length);
  for (const w of ws) {
    let from = 0;
    for (;;) {
      const at = lower.indexOf(w, from);
      if (at < 0) break;
      const before = at === 0 ? "" : text[at - 1];
      if (!before || !/[\p{L}\p{N}]/u.test(before)) marks.fill(1, at, at + w.length);
      from = at + 1;
    }
  }
  const out: Segment[] = [];
  for (let i = 0; i < text.length; ) {
    let j = i;
    while (j < text.length && marks[j] === marks[i]) j++;
    out.push({ text: text.slice(i, j), hit: marks[i] === 1 });
    i = j;
  }
  return out;
}
