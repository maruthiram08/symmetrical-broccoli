// Picks the items an Ask question is about, locally, with the existing search. No transcripts:
// only stored items (text, person, quote, close quote) and their meeting titles and dates.
import { buildIndex, search, terms, type SearchHit } from "../search";
import type { Item, ItemKind, Meeting } from "../types";

/** Most sources sent with one question. */
export const MAX_SOURCES = 40;
/** Hard cap on the sources block, in characters (about 3k tokens). */
export const MAX_CONTEXT_CHARS = 12_000;
export const MAX_QUESTION_CHARS = 500;

const STOP = new Set(
  ("a an the and or but if of to in on at by for from with about as is are was were be been being do does did done " +
    "i me my mine we us our you your he she they them their it its this that these those there here what which who whom " +
    "whose when where why how any all some anything something everything can could should would will shall may might must " +
    "have has had get got tell show give list find say said know think let lets please just still yet ever also so than then " +
    "not no yes up out over into again very really much many more most last next week today yesterday tomorrow time thing things")
    .split(" "),
);

/** The question's content words (stopwords dropped), for the local search. */
export function questionTerms(q: string): string[] {
  return terms(q).filter((w) => !STOP.has(w) && w.length > 1);
}

/** Kinds the question hints at, to fill in when the words alone find little. */
export function kindHints(q: string): { kinds: ItemKind[]; overdue: boolean } {
  const s = q.toLowerCase();
  const kinds = new Set<ItemKind>();
  if (/\b(i owe|do i owe|owe|promised|my promises|i said i'?d|to ?do|on my plate)\b/.test(s)) kinds.add("owe");
  if (/\b(owes? me|waiting|wait on|chase|nudge|follow ?up|pending from)\b/.test(s)) kinds.add("waiting");
  if (/\b(decid\w*|decision\w*|agreed|conclud\w*)\b/.test(s)) kinds.add("decision");
  const overdue = /\b(overdue|late|slipp\w*|missed|behind)\b/.test(s);
  if (overdue) { kinds.add("owe"); kinds.add("waiting"); }
  return { kinds: [...kinds], overdue };
}

/** An item (owe / waiting / decision) cited by Ask. */
export interface ItemSource {
  /** 1-based, as cited: [1]. */
  n: number;
  type?: "item";
  itemId: string;
  kind: ItemKind;
  status: Item["status"];
  text: string;
  person: string | null;
  quote: string;
  closeQuote: string | null;
  dueAt: string | null;
  meetingTitle: string;
  /** Meeting start, ISO. */
  at: string;
  /** Where the citation links (set by the server). */
  href?: string;
}

/** A passage from local search: a meeting summary, a transcript chunk or a note. */
export interface PassageSource {
  n: number;
  type: "meeting" | "transcript" | "note";
  /** The local index's document id. */
  docId: string;
  title: string;
  /** The passage itself, sent as context and shown as the quote. */
  text: string;
  at: string | null;
  href: string;
  meetingId?: string;
}

export type Source = ItemSource | PassageSource;
export const isItemSource = (s: Source): s is ItemSource => s.type === undefined || s.type === "item";

/**
 * Up to MAX_SOURCES items, best match first: search hits for the content words, then (when the
 * question asks about owe / waiting / decisions / overdue) the most recent such items. Items marked
 * wrong never count. Returns [] when nothing relates, so the caller can answer without a model call.
 */
export function retrieve(question: string, items: Item[], meetings: Meeting[], now: Date, limit = MAX_SOURCES): ItemSource[] {
  const byId = new Map(meetings.map((m) => [m.id, m]));
  const itemById = new Map(items.map((i) => [i.id, i]));
  const picked: Item[] = [];
  const seen = new Set<string>();
  const add = (i: Item | undefined) => {
    if (!i || i.status === "wrong" || seen.has(i.id) || picked.length >= limit) return;
    seen.add(i.id);
    picked.push(i);
  };

  const ws = questionTerms(question);
  if (ws.length) {
    const hits = search(buildIndex(items, meetings), ws.join(" "), 500);
    // Items first; a matching meeting brings its items along.
    for (const h of hits) if (h.type === "item") add(itemById.get(h.id));
    for (const h of hits.filter((x): x is Extract<SearchHit, { type: "meeting" }> => x.type === "meeting")) {
      for (const i of items) if (i.meetingId === h.id) add(i);
    }
  }

  const { kinds, overdue } = kindHints(question);
  if (kinds.length && picked.length < limit) {
    const at = (i: Item) => byId.get(i.meetingId)?.startedAt ?? i.createdAt;
    const pool = items
      .filter((i) => kinds.includes(i.kind) && i.status === "open")
      .filter((i) => !overdue || (i.dueAt !== null && Date.parse(i.dueAt) < now.getTime()))
      .sort((a, b) => at(b).localeCompare(at(a)));
    for (const i of pool) add(i);
  }

  return picked.map((i, k) => {
    const m = byId.get(i.meetingId);
    return {
      n: k + 1, itemId: i.id, kind: i.kind, status: i.status, text: i.text, person: i.person,
      quote: i.quote, closeQuote: i.closeQuote, dueAt: i.dueAt,
      meetingTitle: m?.title ?? "a meeting", at: m?.startedAt ?? i.createdAt,
    };
  });
}
