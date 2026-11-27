// Merging notes, as pure functions: the merged Markdown, links in other notes pointed at the note
// that stays, and how alike two notes are (to suggest which one to merge with). No disk access;
// src/server/local/merge.ts does the reading, writing and undo.
import { findWikiLinks, formatWikiLink, noteSlug, type WikiLink } from "@/lib/editor/links";
import { readProperties, setProperties, splitFrontMatter, type PropValue } from "@/lib/structure/frontmatter";

export interface MergeNote {
  path: string;
  /** File name without .md. */
  name: string;
  /** The first "# Heading", else the name. */
  title: string;
  markdown: string;
}

export interface PropConflict { key: string; kept: string; dropped: string; from: string }

export interface MergeResult {
  markdown: string;
  /** Lines left out because the note already had them (to-dos, decisions, bullets). */
  skipped: number;
  /** Lines added from the other notes. */
  added: number;
  conflicts: PropConflict[];
  /** Sources that added nothing new. */
  emptySources: string[];
}

const show = (v: PropValue) => (Array.isArray(v) ? v.join(", ") : v === null ? "" : String(v));
const asList = (v: PropValue): string[] => (Array.isArray(v) ? v : v === null || v === "" ? [] : [String(v)]);
const uniq = (xs: string[]) => { const seen = new Set<string>(); return xs.filter((x) => { const k = x.trim().toLowerCase(); if (!k || seen.has(k)) return false; seen.add(k); return true; }); };

/**
 * A line in a form where two copies of the same thing match: list and task markers gone (so an open
 * and a ticked copy are the same to-do), item links by id, spaces and case folded. Null for lines
 * too short to judge (blank, "---", a lone bullet).
 */
export function lineKey(line: string): string | null {
  let s = line.trim();
  if (/^(?:#{1,6}\s|---+$|\*\*\*+$|```|~~~|\$\$$|<\/?details|<summary)/.test(s)) return null;
  s = s.replace(/^(?:>\s*)+/, "").replace(/^(?:[-*+]|\d+[.)])\s+/, "").replace(/^\[[ xX]\]\s+/, "");
  s = s.replace(/\[\[item:([^|\]]+)(?:\|[^\]]*)?\]\]/gi, "item:$1");
  s = s.replace(/\s+/g, " ").toLowerCase();
  return s.replace(/[^\p{L}\p{N}]+/gu, "").length >= 4 ? s : null;
}

/** The body without front matter and without a first "# Title" that repeats the note's title. */
export function bodyOf(n: MergeNote): string {
  let body = splitFrontMatter(n.markdown).body.replace(/^﻿/, "");
  const h1 = body.match(/^\s*#\s+(.+?)\s*#*\s*(?:\r?\n|$)/);
  if (h1 && [n.title, n.name].some((t) => t.trim().toLowerCase() === h1[1].trim().toLowerCase())) body = body.slice(h1[0].length);
  return body.replace(/\r\n/g, "\n");
}

/** Combine properties: missing keys are added, lists joined, and the note that stays wins a clash. */
function mergeProps(target: MergeNote, sources: MergeNote[]): { changes: Record<string, PropValue>; conflicts: PropConflict[] } {
  const mine = readProperties(target.markdown);
  const changes: Record<string, PropValue> = {};
  const conflicts: PropConflict[] = [];
  const cur = (k: string): PropValue | undefined => (k in changes ? changes[k] : mine[k]);
  for (const s of sources) {
    const theirs = readProperties(s.markdown);
    for (const [k, v] of Object.entries(theirs)) {
      if (k === "merged_from" || k === "aliases") continue;
      const have = cur(k);
      if (have === undefined || have === null || have === "") { changes[k] = v; continue; }
      if (Array.isArray(have) || Array.isArray(v)) {
        const joined = uniq([...asList(have), ...asList(v)]);
        if (joined.length !== asList(have).length) changes[k] = joined;
        continue;
      }
      if (show(have).trim().toLowerCase() !== show(v).trim().toLowerCase() && show(v).trim()) conflicts.push({ key: k, kept: show(have), dropped: show(v), from: s.name });
    }
  }
  // The old names stay findable: as aliases (Obsidian resolves them) and in merged_from.
  const names = sources.flatMap((s) => uniq([s.name, s.title])).filter((n) => n.toLowerCase() !== target.name.toLowerCase() && n.toLowerCase() !== target.title.toLowerCase());
  const aliasesNow = asList(mine.aliases ?? null);
  const sourceAliases = sources.flatMap((s) => asList(readProperties(s.markdown).aliases ?? null));
  const aliases = uniq([...aliasesNow, ...sourceAliases, ...names]);
  if (aliases.length !== aliasesNow.length) changes.aliases = aliases;
  const from = uniq([...asList(mine.merged_from ?? null), ...sources.flatMap((s) => asList(readProperties(s.markdown).merged_from ?? null)), ...sources.map((s) => s.name)]);
  changes.merged_from = from;
  return { changes, conflicts };
}

/**
 * Merge `sources` into `target`, in order. Each source's text goes under "## From <name>", without
 * lines the note already has. Code blocks and math blocks are kept whole.
 */
export function mergeNotes(target: MergeNote, sources: MergeNote[]): MergeResult {
  const eol = /\r\n/.test(target.markdown) ? "\r\n" : "\n";
  const seen = new Set<string>();
  for (const l of bodyOf(target).split("\n")) { const k = lineKey(l); if (k) seen.add(k); }
  // The target's own title line counts too.
  const { raw } = splitFrontMatter(target.markdown);
  const targetBody = target.markdown.slice(raw.length).replace(/\r\n/g, "\n").replace(/\s+$/, "");
  const parts: string[] = [targetBody];
  let skipped = 0, added = 0;
  const emptySources: string[] = [];
  for (const s of sources) {
    const kept: string[] = [];
    let fence: string | null = null;
    for (const line of bodyOf(s).split("\n")) {
      const t = line.trim();
      if (fence) { kept.push(line); if (t.startsWith(fence) && (fence !== "$$" || t.endsWith("$$"))) fence = null; continue; }
      const open = t.match(/^(```|~~~)/)?.[1] ?? (t === "$$" ? "$$" : null);
      if (open) { fence = open; kept.push(line); continue; }
      const k = lineKey(line);
      if (k && seen.has(k)) { skipped++; continue; }
      if (k) seen.add(k);
      kept.push(line);
    }
    // Drop empty lists of blanks and headings left with nothing under them at the end.
    const text = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    const meaningful = text.split("\n").filter((l) => l.trim() && !/^#{1,6}\s/.test(l.trim())).length;
    if (!meaningful) { emptySources.push(s.name); continue; }
    added += text.split("\n").filter((l) => l.trim()).length;
    parts.push(`## From ${s.title}\n\n${text}`);
  }
  const body = parts.filter((p) => p.trim()).join("\n\n") + "\n";
  const { changes, conflicts } = mergeProps(target, sources);
  const withFront = setProperties(raw + body, changes);
  return { markdown: eol === "\r\n" ? withFront.replace(/\r?\n/g, "\r\n") : withFront, skipped, added, conflicts, emptySources };
}

/** Does this link point at one of these notes (by name, title or path, ignoring "#heading")? */
export function linkHits(l: WikiLink, notes: Array<{ path: string; name: string; title: string }>): number {
  if (l.kind !== null && l.kind !== "note") return -1;
  const target = l.target.replace(/#.*$/, "").trim();
  const want = target.toLowerCase().replace(/\.md$/i, "");
  const slug = noteSlug(target);
  return notes.findIndex((n) => want === n.path.toLowerCase().replace(/\.md$/i, "") || want === n.name.toLowerCase() || want === n.title.toLowerCase() || slug === noteSlug(n.name) || slug === noteSlug(n.title));
}

/**
 * Point links to the merged notes at the note that stays. The old name stays as the link's label,
 * so a sentence reading "see [[Standup notes 2]]" still reads the same. "#heading" parts are kept.
 */
export function rewriteLinks(md: string, from: Array<{ path: string; name: string; title: string }>, to: { name: string }): { markdown: string; count: number } {
  const links = findWikiLinks(md).filter((l) => linkHits(l, from) >= 0);
  if (!links.length) return { markdown: md, count: 0 };
  let out = "";
  let at = 0;
  for (const l of links) {
    const hash = l.target.includes("#") ? l.target.slice(l.target.indexOf("#")) : "";
    const oldShown = l.label === l.target ? l.target.replace(/#.*$/, "") : l.label;
    const target = l.kind === "note" ? `${noteSlug(to.name)}${hash}` : `${to.name}${hash}`;
    const label = oldShown.toLowerCase() === to.name.toLowerCase() ? null : oldShown;
    out += md.slice(at, l.from) + formatWikiLink(l.kind, target, label);
    at = l.to;
  }
  return { markdown: out + md.slice(at), count: links.length };
}

const STOP = new Set(["the", "and", "for", "with", "notes", "note", "meeting", "call", "sync", "md"]);
const words = (s: string) => new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 && !STOP.has(w)));

/** How alike two notes look, 0 to 1: shared lines, title words, the same date or people. */
export function similarity(a: MergeNote, b: MergeNote): number {
  const la = new Set(bodyOf(a).split("\n").map(lineKey).filter((x): x is string => !!x));
  const lb = new Set(bodyOf(b).split("\n").map(lineKey).filter((x): x is string => !!x));
  let shared = 0;
  for (const k of la) if (lb.has(k)) shared++;
  const lines = la.size && lb.size ? shared / Math.min(la.size, lb.size) : 0;
  const ta = words(`${a.name} ${a.title}`), tb = words(`${b.name} ${b.title}`);
  let tw = 0;
  for (const w of ta) if (tb.has(w)) tw++;
  const title = ta.size && tb.size ? tw / Math.max(ta.size, tb.size) : 0;
  const pa = readProperties(a.markdown), pb = readProperties(b.markdown);
  const sameDate = ["date", "meeting", "meeting_id", "created"].some((k) => pa[k] != null && pa[k] !== "" && show(pa[k]) === show(pb[k] ?? null)) ? 1 : 0;
  return Math.min(1, lines * 0.6 + title * 0.3 + sameDate * 0.3);
}
