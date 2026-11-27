// Merging notes in the workspace folder: preview, merge and undo. The note that stays gets the
// others' text (src/lib/vault/merge.ts), links anywhere in the folder are pointed at it, and the
// merged notes go to .trash. A record of what changed is kept in .trash/.merges so one click puts
// everything back, as long as nothing was edited since (an edited file is left as it is).
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { mergeNotes, rewriteLinks, similarity, type MergeNote, type PropConflict } from "@/lib/vault/merge";
import { titleOf } from "./pages";
import { absIn, cleanRel, noteName, readVaultNote, saveVaultNote, trashVaultEntry, TRASH, VaultError, walkVault } from "./vault";
import { refreshVaultIndex, vaultTexts } from "./vault-index";

const DAY_FILE = /(^|\/)\d{4}-\d{2}-\d{2}\.md$/;
const JOURNAL = `${TRASH}/.merges`;
const MAX_SOURCES = 8;

export interface MergePreview {
  target: string;
  sources: string[];
  markdown: string;
  skipped: number;
  added: number;
  conflicts: PropConflict[];
  emptySources: string[];
  /** Other notes whose links will point at the note that stays. */
  relinked: Array<{ path: string; count: number }>;
}

export interface MergeDone extends MergePreview { id: string }

interface Journal {
  id: string;
  at: string;
  target: { path: string; before: string; afterHash: string };
  sources: Array<{ path: string; trashed: string }>;
  relinked: Array<{ path: string; before: string; afterHash: string }>;
}

function asNote(root: string, path: string): MergeNote & { hash: string } {
  const clean = cleanRel(path);
  if (!clean) throw new VaultError("That note isn't in this workspace.");
  if (DAY_FILE.test(clean)) throw new VaultError("Daily pages can't be merged. Copy what you need into a note instead.");
  const n = readVaultNote(root, clean);
  if (!n) throw new VaultError(`“${noteName(clean)}” isn't there any more.`);
  if (n.readOnly) throw new VaultError(`“${n.name}” is open read-only, so it can't be merged.`);
  return { path: n.path, name: n.name, title: titleOf(n.markdown, n.name), markdown: n.markdown, hash: n.hash };
}

function plan(root: string, targetPath: string, sourcePaths: string[]) {
  const target = asNote(root, targetPath);
  const seen = new Set([target.path]);
  const sources = sourcePaths.map((p) => asNote(root, p)).filter((s) => (seen.has(s.path) ? false : (seen.add(s.path), true)));
  if (!sources.length) throw new VaultError("Pick another note to merge in.");
  if (sources.length > MAX_SOURCES) throw new VaultError(`Merge at most ${MAX_SOURCES} notes at once.`);
  const merged = mergeNotes(target, sources);
  // Links from the merged notes to each other or to themselves now point at the note that stays.
  const self = rewriteLinks(merged.markdown, sources, target);
  const markdown = self.markdown;
  const skip = new Set([target.path, ...sources.map((s) => s.path)]);
  const relinked: Array<{ path: string; before: string; after: string; count: number }> = [];
  for (const [p, text] of vaultTexts(root)) {
    if (skip.has(p) || !text.includes("[[")) continue;
    const r = rewriteLinks(text, sources, target);
    if (r.count) relinked.push({ path: p, before: text, after: r.markdown, count: r.count });
  }
  return { target, sources, merged: { ...merged, markdown }, relinked };
}

export function previewMerge(root: string, targetPath: string, sourcePaths: string[]): MergePreview {
  const p = plan(root, targetPath, sourcePaths);
  return {
    target: p.target.path, sources: p.sources.map((s) => s.path), markdown: p.merged.markdown, skipped: p.merged.skipped, added: p.merged.added,
    conflicts: p.merged.conflicts, emptySources: p.merged.emptySources, relinked: p.relinked.map((r) => ({ path: r.path, count: r.count })),
  };
}

export function mergeVaultNotes(root: string, targetPath: string, sourcePaths: string[], now = new Date()): MergeDone {
  const p = plan(root, targetPath, sourcePaths);
  const id = `${now.toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
  const journal: Journal = { id, at: now.toISOString(), target: { path: p.target.path, before: p.target.markdown, afterHash: "" }, sources: [], relinked: [] };
  const save = () => { mkdirSync(join(root, JOURNAL), { recursive: true }); writeFileSync(join(root, JOURNAL, `${id}.json`), JSON.stringify(journal)); };
  // The record goes first, so a crash part way can still be undone.
  save();
  const t = saveVaultNote(root, p.target.path, p.merged.markdown, p.target.hash, now);
  if (!t.ok) throw new VaultError(t.error);
  journal.target.afterHash = t.hash;
  for (const r of p.relinked) {
    const cur = readVaultNote(root, r.path);
    if (!cur || cur.markdown !== r.before) continue;
    const s = saveVaultNote(root, r.path, r.after, cur.hash, now);
    if (s.ok) journal.relinked.push({ path: r.path, before: r.before, afterHash: s.hash });
  }
  for (const s of p.sources) journal.sources.push({ path: s.path, trashed: trashVaultEntry(root, s.path) });
  save();
  refreshVaultIndex(root, { force: true });
  return {
    id, target: p.target.path, sources: p.sources.map((s) => s.path), markdown: p.merged.markdown, skipped: p.merged.skipped, added: p.merged.added,
    conflicts: p.merged.conflicts, emptySources: p.merged.emptySources, relinked: journal.relinked.map((r) => ({ path: r.path, count: p.relinked.find((x) => x.path === r.path)?.count ?? 0 })),
  };
}

export interface UndoResult { restored: string[]; kept: string[] }

/** Put a merge back: the merged notes out of the trash, the note that stays and the links as they were. */
export function undoMerge(root: string, id: string): UndoResult {
  if (!/^[\w-]{10,80}$/.test(id)) throw new VaultError("That merge can't be found.");
  const file = join(root, JOURNAL, `${id}.json`);
  if (!existsSync(file)) throw new VaultError("That merge can't be found.");
  const j = JSON.parse(readFileSync(file, "utf8")) as Journal;
  const restored: string[] = [], kept: string[] = [];
  for (const s of j.sources) {
    const from = join(root, s.trashed);
    let to: string;
    try { to = absIn(root, s.path); } catch { kept.push(s.path); continue; }
    if (!existsSync(from) || existsSync(to)) { kept.push(s.path); continue; }
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
    restored.push(s.path);
  }
  const back = (path: string, before: string, afterHash: string) => {
    const cur = readVaultNote(root, path);
    if (cur && cur.hash !== afterHash) { kept.push(path); return; }
    saveVaultNote(root, path, before, cur?.hash ?? null);
    restored.push(path);
  };
  back(j.target.path, j.target.before, j.target.afterHash);
  for (const r of j.relinked) back(r.path, r.before, r.afterHash);
  renameSync(file, `${file}.undone`);
  refreshVaultIndex(root, { force: true });
  return { restored, kept };
}

/** The most recent merges that can still be undone, newest first. */
export function recentMerges(root: string, limit = 5): Array<{ id: string; at: string; target: string; sources: string[] }> {
  const dir = join(root, JOURNAL);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().reverse().slice(0, limit).flatMap((f) => {
    try { const j = JSON.parse(readFileSync(join(dir, f), "utf8")) as Journal; return [{ id: j.id, at: j.at, target: j.target.path, sources: j.sources.map((s) => s.path) }]; } catch { return []; }
  });
}

/** Notes that look like this one (a second copy of the same meeting, say), best first. */
export function mergeCandidates(root: string, path: string, limit = 5): Array<{ path: string; name: string; score: number }> {
  let me: MergeNote;
  try { me = asNote(root, path); } catch { return []; }
  const texts = vaultTexts(root);
  const out: Array<{ path: string; name: string; score: number }> = [];
  for (const f of walkVault(root).files) {
    if (f.path === me.path || DAY_FILE.test(f.path) || !/\.(md|markdown)$/i.test(f.path)) continue;
    let text = texts.get(f.path);
    if (text === undefined) { try { if (statSync(join(root, f.path)).size > 500_000) continue; text = readFileSync(join(root, f.path), "utf8"); } catch { continue; } }
    const name = noteName(f.path);
    const score = similarity(me, { path: f.path, name, title: titleOf(text, name), markdown: text });
    if (score >= 0.25) out.push({ path: f.path, name, score: Math.round(score * 100) / 100 });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

