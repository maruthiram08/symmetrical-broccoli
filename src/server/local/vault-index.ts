// Full-text search over every note in a workspace folder, with a small in-memory index
// (MiniSearch). It is kept up to date incrementally: each search first looks at the folder's
// file list (names, sizes and times only) and reads just the notes that were added or changed
// since; saves, renames and deletes made in the app update it straight away.
import MiniSearch from "minisearch";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fold, terms } from "@/lib/search";
import { titleOf } from "./pages";
import { MAX_NOTE_BYTES, noteName, walkVault, type FileEntry } from "./vault";

interface Doc { id: string; title: string; name: string; text: string }
interface Index {
  ms: MiniSearch<Doc>;
  seen: Map<string, string>;
  texts: Map<string, string>;
  titles: Map<string, string>;
  checkedAt: number;
}

const MAX_INDEX_BYTES = 1_000_000;
const RECHECK_MS = 1500;
const indexes = new Map<string, Index>();

const sig = (f: FileEntry) => `${Math.round(f.mtimeMs)}:${f.size}`;

function make(): Index {
  return {
    ms: new MiniSearch<Doc>({
      fields: ["title", "name", "text"],
      storeFields: [],
      processTerm: (t) => fold(t).trim() || null,
      searchOptions: { boost: { title: 3, name: 3 }, prefix: true, fuzzy: (term) => (term.length > 4 ? 0.2 : false), combineWith: "AND" },
    }),
    seen: new Map(), texts: new Map(), titles: new Map(), checkedAt: 0,
  };
}

function put(ix: Index, root: string, f: FileEntry): void {
  let text = "";
  if (f.size <= Math.min(MAX_INDEX_BYTES, MAX_NOTE_BYTES)) {
    try { text = readFileSync(join(root, f.path), "utf8"); } catch { text = ""; }
  }
  const name = noteName(f.path);
  const title = titleOf(text, name);
  const doc: Doc = { id: f.path, title, name: `${name} ${f.path.replace(/[/.-]/g, " ")}`, text };
  if (ix.ms.has(f.path)) ix.ms.replace(doc); else ix.ms.add(doc);
  ix.seen.set(f.path, sig(f));
  ix.texts.set(f.path, text);
  ix.titles.set(f.path, title);
}

function drop(ix: Index, path: string): void {
  if (ix.ms.has(path)) ix.ms.discard(path);
  ix.seen.delete(path);
  ix.texts.delete(path);
  ix.titles.delete(path);
}

export interface RefreshStats { added: number; updated: number; removed: number; total: number }

/** Bring the index in line with the folder. Cheap when nothing changed (no file is read). */
export function refreshVaultIndex(root: string, opts: { force?: boolean; now?: number } = {}): RefreshStats {
  const now = opts.now ?? Date.now();
  let ix = indexes.get(root);
  if (!ix) { ix = make(); indexes.set(root, ix); }
  const stats: RefreshStats = { added: 0, updated: 0, removed: 0, total: ix.seen.size };
  if (!opts.force && now - ix.checkedAt < RECHECK_MS) return stats;
  ix.checkedAt = now;
  const { files } = walkVault(root);
  const present = new Set<string>();
  for (const f of files) {
    present.add(f.path);
    const was = ix.seen.get(f.path);
    if (was === sig(f)) continue;
    put(ix, root, f);
    if (was === undefined) stats.added++; else stats.updated++;
  }
  for (const path of [...ix.seen.keys()]) if (!present.has(path)) { drop(ix, path); stats.removed++; }
  if (ix.ms.dirtCount > 200 && ix.ms.dirtFactor > 0.3) void ix.ms.vacuum();
  stats.total = ix.seen.size;
  return stats;
}

/** After the app itself saved, renamed or deleted notes: update just those. */
export function vaultIndexChanged(root: string, changes: { saved?: Array<{ path: string; mtimeMs: number; size: number }>; removed?: string[] }): void {
  const ix = indexes.get(root);
  if (!ix) return;
  for (const p of changes.removed ?? []) {
    for (const k of [...ix.seen.keys()]) if (k === p || k.startsWith(`${p}/`)) drop(ix, k);
  }
  for (const f of changes.saved ?? []) put(ix, root, f);
}

export interface NoteHit { path: string; title: string; snippet: string; score: number }

/** The line around the first match, trimmed to about 140 characters. */
export function snippetFor(text: string, words: string[]): string {
  const lines = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").split(/\r?\n/);
  const clean = (l: string) => l.replace(/\[\[(?:[a-z]+:)?([^|\]]+)(?:\|([^\]]+))?\]\]/g, (_m, t, lb) => lb ?? t).replace(/^\s*(?:#{1,6}|[-*+]|\d+[.)]|>)\s+(?:\[[ xX]\]\s+)?/, "").replace(/[*_`~=]+/g, "").trim();
  let best = "";
  for (const l of lines) {
    const c = clean(l);
    if (!c) continue;
    if (!best) best = c;
    const f = c.toLowerCase();
    const i = words.length ? Math.min(...words.map((w) => { const k = f.indexOf(w); return k < 0 ? Infinity : k; })) : Infinity;
    if (i !== Infinity) {
      const start = Math.max(0, i - 50);
      return `${start > 0 ? "…" : ""}${c.slice(start, start + 140)}${c.length > start + 140 ? "…" : ""}`;
    }
  }
  return best.slice(0, 140);
}

export function searchVault(root: string, q: string, limit = 8): NoteHit[] {
  const query = q.trim().slice(0, 200);
  if (!query) return [];
  refreshVaultIndex(root);
  const ix = indexes.get(root)!;
  const words = terms(query);
  return ix.ms.search(query).slice(0, limit).map((r) => {
    const path = String(r.id);
    return { path, title: ix.titles.get(path) ?? noteName(path), snippet: snippetFor(ix.texts.get(path) ?? "", words), score: r.score };
  });
}

/** Every indexed note's text, current as of now (for backlinks). */
export function vaultTexts(root: string): Map<string, string> {
  refreshVaultIndex(root);
  return new Map(indexes.get(root)!.texts);
}

/** For tests. */
export function resetVaultIndexes(): void { indexes.clear(); }
