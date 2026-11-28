// Manual links in notes: [[person:Nitin K]], [[note:q4-plan|Q4 plan]], [[meeting:<id>|Standup]],
// [[item:<id>|Send the deck]], [[day:2026-11-26]]. Untyped [[Something]] means a note with that
// title, else a person. In any other Markdown app they stay readable text.
import { personSlug } from "@/lib/people";
import { notesParser } from "./markdown";

export const LINK_KINDS = ["person", "note", "meeting", "item", "day"] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export interface WikiLink {
  /** null when the link had no "kind:" prefix. */
  kind: LinkKind | null;
  target: string;
  label: string;
  /** Offsets of the whole [[...]] in the text. */
  from: number;
  to: number;
}

/** Parse the inside or the whole of a [[...]]. Null when it isn't one. */
export function parseWikiLink(raw: string, from = 0): WikiLink | null {
  const inner = raw.startsWith("[[") && raw.endsWith("]]") ? raw.slice(2, -2) : raw;
  if (!inner.trim() || /[[\]\n]/.test(inner)) return null;
  const bar = inner.indexOf("|");
  const head = bar < 0 ? inner : inner.slice(0, bar);
  const shown = bar < 0 ? null : inner.slice(bar + 1).trim();
  const m = head.match(/^(person|note|meeting|item|day):(.*)$/i);
  const kind = m ? (m[1].toLowerCase() as LinkKind) : null;
  const target = (m ? m[2] : head).trim();
  if (!target) return null;
  return { kind, target, label: shown || target, from, to: from + raw.length };
}

/** Write a link. The label is left out when it would repeat the target. */
export function formatWikiLink(kind: LinkKind | null, target: string, label?: string | null): string {
  const clean = (s: string) => s.replace(/[[\]|\n]+/g, " ").replace(/\s+/g, " ").trim();
  const t = clean(target);
  const l = label ? clean(label) : "";
  const head = kind ? `${kind}:${t}` : t;
  return `[[${head}${l && l !== t ? `|${l}` : ""}]]`;
}

/** Every [[link]] in a Markdown text, skipping code spans and code blocks. */
export function findWikiLinks(md: string): WikiLink[] {
  const out: WikiLink[] = [];
  const tree = notesParser.parse(md);
  tree.iterate({
    enter(n) {
      if (n.name === "WikiLink") {
        const l = parseWikiLink(md.slice(n.from, n.to), n.from);
        if (l) out.push(l);
        return false;
      }
      return undefined;
    },
  });
  return out;
}

/** A note's slug from its title: "Q4 plan!" -> "q4-plan". */
export function noteSlug(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "untitled";
}

export interface LinkResolver {
  /** Note slugs and titles, to resolve [[Untyped]] links. */
  notes?: Array<{ slug: string; title: string }>;
}

/** Where a link goes in the app. */
export function linkHref(l: Pick<WikiLink, "kind" | "target" | "label">, r: LinkResolver = {}): string {
  switch (l.kind) {
    case "person": return `/people/${encodeURIComponent(personSlug(l.target))}`;
    case "note": return `/notes/${encodeURIComponent(noteSlug(l.target))}`;
    case "item": return `/item/${encodeURIComponent(l.target)}`;
    case "day": return /^\d{4}-\d{2}-\d{2}$/.test(l.target) ? `/day/${l.target}` : `/search?q=${encodeURIComponent(l.target)}`;
    case "meeting": return `/search?q=${encodeURIComponent(l.label)}`;
    default: {
      const want = l.target.toLowerCase();
      const note = r.notes?.find((n) => n.slug === noteSlug(l.target) || n.title.toLowerCase() === want);
      return note ? `/notes/${encodeURIComponent(note.slug)}` : `/people/${encodeURIComponent(personSlug(l.target))}`;
    }
  }
}

/**
 * True when the link points at this person (typed, or an untyped name that isn't a note).
 * `isThem` decides whether a name is theirs: a list of spellings, or the people grouping's own test.
 */
export function linksToPerson(l: WikiLink, isThem: string[] | ((name: string) => boolean), r: LinkResolver = {}): boolean {
  if (l.kind !== "person" && l.kind !== null) return false;
  if (l.kind === null && r.notes?.some((n) => n.slug === noteSlug(l.target) || n.title.toLowerCase() === l.target.toLowerCase())) return false;
  if (typeof isThem === "function") return isThem(l.target);
  const slug = personSlug(l.target);
  return isThem.some((k) => personSlug(k) === slug);
}

export function linksToNote(l: WikiLink, note: { slug: string; title: string }): boolean {
  if (l.kind !== "note" && l.kind !== null) return false;
  return noteSlug(l.target) === note.slug || l.target.toLowerCase() === note.title.toLowerCase();
}

export interface LinkSource {
  /** "note" pages or "day" notes. */
  type: "note" | "day";
  /** Slug for notes, YYYY-MM-DD for days. */
  id: string;
  title: string;
  markdown: string;
}

export interface Backlink {
  type: LinkSource["type"];
  id: string;
  title: string;
  href: string;
  /** The line around each link, as plain-ish text. */
  snippets: string[];
}

/** The line holding a link, with link markup turned into its label. */
function snippetAt(md: string, at: number): string {
  const start = md.lastIndexOf("\n", at - 1) + 1;
  const endRaw = md.indexOf("\n", at);
  const line = md.slice(start, endRaw < 0 ? md.length : endRaw);
  return line
    .replace(/!?\[\[([^[\]\n]+)\]\]/g, (_m, inner: string) => parseWikiLink(inner)?.label ?? inner)
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]\s+/, "")
    .replace(/^\s*(?:>\s*)+(?:\[![a-z]+\]\s*)?/i, "")
    .replace(/^\s*(?:#{1,6}|[-*+]|\d+[.)])\s+/, "")
    .replace(/[*_`~]+/g, "")
    .trim()
    .slice(0, 240);
}

/** Pages that link here, newest day first then notes by title, each with the lines that link. */
export function backlinks(sources: LinkSource[], matches: (l: WikiLink) => boolean, self?: { type: LinkSource["type"]; id: string }): Backlink[] {
  const out: Backlink[] = [];
  for (const s of sources) {
    if (self && s.type === self.type && s.id === self.id) continue;
    const hits = findWikiLinks(s.markdown).filter(matches);
    if (!hits.length) continue;
    const snippets = [...new Set(hits.map((h) => snippetAt(s.markdown, h.from)).filter(Boolean))].slice(0, 3);
    out.push({ type: s.type, id: s.id, title: s.title, href: s.type === "day" ? `/day/${s.id}` : `/notes/${encodeURIComponent(s.id)}`, snippets });
  }
  return out.sort((a, b) => (a.type !== b.type ? (a.type === "day" ? -1 : 1) : a.type === "day" ? b.id.localeCompare(a.id) : a.title.localeCompare(b.title)));
}
