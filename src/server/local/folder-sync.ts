// Folder sync: mirror the notes (daily notes, decisions.md, weekly recaps, people/ and meetings/)
// one way into <folder>/daily-brief/, say an iCloud Drive folder or an Obsidian vault.
// Every write is atomic and skipped when nothing changed. Only files this app put in
// daily-brief/ (listed in its manifest) are ever removed; nothing outside daily-brief/ is touched.

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { writeAtomic } from "./atomic";
import { normalizeFolder, within, type Workspace } from "./workspaces";

export const SYNC_SUBFOLDER = "daily-brief";
const MANIFEST = ".daily-brief-sync.json";
const ROOT_FILES = /^(\d{4}-\d{2}-\d{2}|week-\d{4}-W\d{2}|decisions)\.md$/;
const SUBDIRS = ["people", "meetings"];

export interface FolderSyncResult { copied: number; unchanged: number; removed: number; target: string }

/** The notes files to mirror, as paths relative to the notes folder ("people/Nitin.md"). */
export function mirroredFiles(notes: string): string[] {
  if (!existsSync(notes)) return [];
  const out = readdirSync(notes).filter((f) => ROOT_FILES.test(f) && isFile(join(notes, f)));
  for (const d of SUBDIRS) {
    const dir = join(notes, d);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir)) if (f.endsWith(".md") && !f.startsWith(".") && isFile(join(dir, f))) out.push(`${d}/${f}`);
  }
  return out.sort();
}

function isFile(p: string): boolean {
  try { return lstatSync(p).isFile(); } catch { return false; }
}

const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };

/** Why a folder can't be the sync folder for this workspace, or null when it can. */
export function syncFolderProblem(ws: Pick<Workspace, "path">, folder: string): string | null {
  if (!folder.trim()) return "Pick a folder.";
  const f = normalizeFolder(folder);
  if (!existsSync(f) || !statSync(f).isDirectory()) return "That folder doesn't exist. Create it first (say, in Finder).";
  const notes = real(ws.path), target = real(f);
  if (within(notes, target)) return "Pick a folder outside your notes folder.";
  // The notes folder may sit inside the sync folder, but not where the mirror would go.
  if (within(join(target, SYNC_SUBFOLDER), notes)) return "Your notes folder is already that folder's daily-brief/ subfolder.";
  return null;
}

function readManifest(target: string): string[] {
  try {
    const o = JSON.parse(readFileSync(join(target, MANIFEST), "utf8")) as { files?: unknown };
    return Array.isArray(o.files) ? o.files.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Mirror the workspace's notes into <folder>/daily-brief/. Throws with a plain message on a bad folder. */
export function syncFolder(ws: Pick<Workspace, "path">, folder: string): FolderSyncResult {
  const problem = syncFolderProblem(ws, folder);
  if (problem) throw new Error(problem);
  const target = join(normalizeFolder(folder), SYNC_SUBFOLDER);
  const files = mirroredFiles(ws.path);
  let copied = 0, unchanged = 0, removed = 0;
  for (const rel of files) {
    const dest = join(target, rel);
    if (existsSync(dest) && !isFile(dest)) continue; // a folder or link of yours with that name: leave it
    if (writeAtomic(dest, readFileSync(join(ws.path, rel), "utf8"))) copied++;
    else unchanged++;
  }
  // Files we mirrored before whose source is gone (a renamed person, say). Only ours, only inside daily-brief/.
  const keep = new Set(files);
  for (const rel of readManifest(target)) {
    if (keep.has(rel) || rel.includes("..") || rel.startsWith(sep) || !(ROOT_FILES.test(rel) || SUBDIRS.some((d) => rel.startsWith(`${d}/`) && rel.endsWith(".md")))) continue;
    const dest = join(target, rel);
    if (!within(target, dest) || relative(target, dest) !== rel.split("/").join(sep) || !isFile(dest)) continue;
    try { unlinkSync(dest); removed++; } catch { /* already gone */ }
  }
  writeAtomic(join(target, MANIFEST), JSON.stringify({ note: "Files Daily brief mirrors here. Edit the originals; these are overwritten.", files }, null, 2) + "\n");
  return { copied, unchanged, removed, target };
}
