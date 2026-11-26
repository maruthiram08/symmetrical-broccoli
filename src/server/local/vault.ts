// Any Markdown folder as a workspace (an Obsidian vault, a git repo of notes): its tree of folders
// and .md files, and the file operations the sidebar offers. Files are read and written byte for
// byte; nothing is written unless you changed it. Hidden folders (.obsidian, .git, .trash, the
// app's own .daily-brief), node_modules, anything .gitignore'd and Obsidian's "Excluded files" are
// left out. Deleting moves a file or folder into <folder>/.trash, the same place Obsidian uses.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { basename, dirname, extname, join, posix, relative, sep } from "node:path";
import ignore, { type Ignore } from "ignore";
import { hashOf, writeKeepingConflict } from "./pages";

export const TRASH = ".trash";
export const MAX_NOTE_BYTES = 5_000_000;
const MAX_ENTRIES = 20_000;
const MAX_DEPTH = 24;
const SKIP = new Set(["node_modules"]);
const MD_RE = /\.(md|markdown)$/i;
export const ASSET_RE = /\.(png|jpe?g|gif|webp|svg|avif|bmp|pdf)$/i;

export interface TreeFolder { type: "folder"; name: string; path: string; children: TreeNode[] }
export interface TreeFile { type: "file"; name: string; path: string; mtimeMs: number; size: number }
export type TreeNode = TreeFolder | TreeFile;
export interface FileEntry { path: string; mtimeMs: number; size: number }

export class VaultError extends Error {}

/**
 * A path from the browser, relative to the workspace folder ("Projects/Alpha.md"). Null when it
 * could leave the folder or names something hidden: no "..", no leading "/", no ".x" segments.
 */
export function cleanRel(rel: unknown): string | null {
  if (typeof rel !== "string") return null;
  if (rel === "") return "";
  if (rel.length > 1024 || rel.includes("\0") || rel.includes("\\") || rel.startsWith("/")) return null;
  const parts = rel.split("/");
  if (parts[parts.length - 1] === "") parts.pop();
  for (const p of parts) {
    if (!p || p === "." || p === ".." || p.startsWith(".") || p.length > 255) return null;
  }
  return parts.join("/");
}

const toPosix = (p: string) => (sep === "/" ? p : p.split(sep).join("/"));

/** The absolute path for a clean relative one, refusing anything (even through a symlink) outside root. */
export function absIn(root: string, rel: string): string {
  const clean = cleanRel(rel);
  if (clean === null) throw new VaultError("That path isn't in this workspace.");
  const abs = join(root, clean);
  const realRoot = realpathSync(root);
  // The deepest part that exists must resolve inside the root.
  let probe = abs;
  while (!existsSync(probe) && probe !== root && dirname(probe) !== probe) probe = dirname(probe);
  const real = realpathSync(probe);
  const r = relative(realRoot, real);
  if (r.startsWith("..") || (r !== "" && /^([a-z]:|\/)/i.test(r))) throw new VaultError("That path isn't in this workspace.");
  return abs;
}

export const isNote = (name: string) => MD_RE.test(name);

// ---------- what to leave out ----------

interface Rules { stack: Array<{ base: string; ig: Ignore }>; obsidian: Array<(rel: string) => boolean> }

/** Obsidian's Settings › Files › Excluded files: path prefixes, or /regexes/. */
export function obsidianFilters(root: string): Array<(rel: string) => boolean> {
  try {
    const app = JSON.parse(readFileSync(join(root, ".obsidian", "app.json"), "utf8")) as { userIgnoreFilters?: unknown };
    if (!Array.isArray(app.userIgnoreFilters)) return [];
    const out: Array<(rel: string) => boolean> = [];
    for (const f of app.userIgnoreFilters.slice(0, 200)) {
      if (typeof f !== "string" || !f.trim()) continue;
      const re = f.match(/^\/(.+)\/([a-z]*)$/);
      if (re) {
        try { const r = new RegExp(re[1], re[2].replace(/[^imsu]/g, "")); out.push((p) => r.test(p)); } catch { /* skip a bad pattern */ }
      } else {
        const pre = f.replace(/^\/+/, "");
        out.push((p) => p === pre.replace(/\/$/, "") || p.startsWith(pre.endsWith("/") ? pre : `${pre}/`) || (!pre.endsWith("/") && p.startsWith(pre)));
      }
    }
    return out;
  } catch {
    return [];
  }
}

function gitignoreAt(absDir: string): Ignore | null {
  try {
    const text = readFileSync(join(absDir, ".gitignore"), "utf8");
    return ignore().add(text);
  } catch {
    return null;
  }
}

function leftOut(rules: Rules, rel: string, isDir: boolean): boolean {
  for (const { base, ig } of rules.stack) {
    const sub = base ? rel.slice(base.length + 1) : rel;
    if (sub && ig.ignores(isDir ? `${sub}/` : sub)) return true;
  }
  return rules.obsidian.some((f) => f(rel) || (isDir && f(`${rel}/`)));
}

/** Rules for one path, for checking a single file outside a full walk. */
export function isLeftOut(root: string, rel: string, isDir = false): boolean {
  const clean = cleanRel(rel);
  if (clean === null) return true;
  if (!clean) return false;
  const parts = clean.split("/");
  if (parts.some((p) => SKIP.has(p))) return true;
  const rules: Rules = { stack: [], obsidian: obsidianFilters(root) };
  for (let i = 0; i < parts.length; i++) {
    const base = parts.slice(0, i).join("/");
    const ig = gitignoreAt(join(root, base));
    if (ig) rules.stack.push({ base, ig });
    const here = parts.slice(0, i + 1).join("/");
    if (leftOut(rules, here, i < parts.length - 1 || isDir)) return true;
  }
  return false;
}

// ---------- the tree ----------

const byName = (a: TreeNode, b: TreeNode) =>
  a.type !== b.type ? (a.type === "folder" ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

/** Every visible folder and note, folders first, by name. `files` lists the notes flat. */
export function walkVault(root: string): { tree: TreeNode[]; files: FileEntry[]; truncated: boolean } {
  const files: FileEntry[] = [];
  let count = 0;
  let truncated = false;
  if (!existsSync(root)) return { tree: [], files, truncated };
  const rules: Rules = { stack: [], obsidian: obsidianFilters(root) };

  const visit = (absDir: string, rel: string, depth: number): TreeNode[] => {
    const ig = gitignoreAt(absDir);
    if (ig) rules.stack.push({ base: rel, ig });
    let entries: Dirent[] = [];
    try { entries = readdirSync(absDir, { withFileTypes: true }); } catch { entries = []; }
    const out: TreeNode[] = [];
    for (const e of entries) {
      if (count >= MAX_ENTRIES) { truncated = true; break; }
      if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const abs = join(absDir, e.name);
      let isDir = e.isDirectory();
      let isFile = e.isFile();
      if (e.isSymbolicLink()) {
        // Linked files are fine when they stay inside the folder; linked folders are skipped (no loops).
        try {
          const st = statSync(abs);
          if (st.isDirectory()) continue;
          isFile = st.isFile();
          isDir = false;
          const r = relative(realpathSync(root), realpathSync(abs));
          if (r.startsWith("..")) continue;
        } catch { continue; }
      }
      if (isDir) {
        if (leftOut(rules, childRel, true)) continue;
        if (depth >= MAX_DEPTH) { truncated = true; continue; }
        count++;
        out.push({ type: "folder", name: e.name, path: childRel, children: visit(abs, childRel, depth + 1) });
      } else if (isFile && isNote(e.name)) {
        if (leftOut(rules, childRel, false)) continue;
        let st: { mtimeMs: number; size: number };
        try { st = statSync(abs); } catch { continue; }
        count++;
        files.push({ path: childRel, mtimeMs: st.mtimeMs, size: st.size });
        out.push({ type: "file", name: e.name, path: childRel, mtimeMs: st.mtimeMs, size: st.size });
      }
    }
    if (ig) rules.stack.pop();
    return out.sort(byName);
  };

  const tree = visit(root, "", 0);
  return { tree, files, truncated };
}

/** Changes whenever a note is added, removed, renamed or saved, so the sidebar knows to refresh. */
export function treeSignature(files: FileEntry[]): string {
  return hashOf(files.map((f) => `${f.path}\0${Math.round(f.mtimeMs)}\0${f.size}`).sort().join("\n"));
}

/** Every folder's path, for "Move to…". "" is the workspace folder itself. */
export function folderPaths(tree: TreeNode[]): string[] {
  const out = [""];
  const walk = (ns: TreeNode[]) => { for (const n of ns) if (n.type === "folder") { out.push(n.path); walk(n.children); } };
  walk(tree);
  return out;
}

// ---------- notes ----------

/** "Projects/Alpha.md" -> "Alpha". */
export const noteName = (rel: string) => basename(rel).replace(MD_RE, "");

export interface VaultNote {
  path: string;
  name: string;
  markdown: string;
  hash: string;
  /** Not valid UTF-8 (or too big): shown, never saved, so its bytes can't be changed by accident. */
  readOnly: boolean;
  mtimeMs: number;
}

export function readVaultNote(root: string, rel: string): VaultNote | null {
  const clean = cleanRel(rel);
  if (!clean || !isNote(clean)) return null;
  let abs: string;
  try { abs = absIn(root, clean); } catch { return null; }
  let st;
  try { st = lstatSync(abs); } catch { return null; }
  if (st.isSymbolicLink()) { try { st = statSync(abs); } catch { return null; } }
  if (!st.isFile()) return null;
  if (st.size > MAX_NOTE_BYTES) return { path: clean, name: noteName(clean), markdown: "", hash: "", readOnly: true, mtimeMs: st.mtimeMs };
  const bytes = readFileSync(abs);
  const markdown = bytes.toString("utf8");
  const readOnly = !Buffer.from(markdown, "utf8").equals(bytes);
  return { path: clean, name: noteName(clean), markdown, hash: hashOf(markdown), readOnly, mtimeMs: st.mtimeMs };
}

/** The hash of a note on disk now, to notice edits made in another app. Null when it's gone. */
export function statVaultNote(root: string, rel: string): { hash: string; mtimeMs: number } | null {
  const n = readVaultNote(root, rel);
  return n ? { hash: n.hash, mtimeMs: n.mtimeMs } : null;
}

export type VaultSave = { ok: true; hash: string; conflict?: string; written: boolean } | { ok: false; error: string };

export function saveVaultNote(root: string, rel: string, markdown: string, base: string | null, now = new Date()): VaultSave {
  const clean = cleanRel(rel);
  if (!clean || !isNote(clean)) return { ok: false, error: "Only .md notes can be saved here." };
  if (markdown.length > 1_000_000) return { ok: false, error: "That note is too long to save." };
  let abs: string;
  try { abs = absIn(root, clean); } catch (e) { return { ok: false, error: (e as Error).message }; }
  const cur = readVaultNote(root, clean);
  if (cur?.readOnly) return { ok: false, error: "This file isn't plain UTF-8 text, so it's open read-only." };
  mkdirSync(dirname(abs), { recursive: true });
  const r = writeKeepingConflict(abs, markdown, base, now);
  return { ok: true, hash: r.hash, written: r.written, conflict: r.conflict ? posix.join(posix.dirname(clean), r.conflict).replace(/^\.\//, "") : undefined };
}

/** A safe file name from what was typed: no slashes or reserved characters, no leading dot. */
export function safeName(input: string, fallback = "Untitled"): string {
  const s = input.replace(/[\\/:*?"<>|\0-\x1f]+/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "").slice(0, 120).trim();
  return s || fallback;
}

function freePath(root: string, folder: string, stem: string, ext: string): string {
  for (let n = 1; n < 1000; n++) {
    const name = `${stem}${n > 1 ? ` ${n}` : ""}${ext}`;
    const rel = folder ? `${folder}/${name}` : name;
    if (!existsSync(join(root, rel))) return rel;
  }
  throw new VaultError("Too many files with that name.");
}

function folderOrThrow(root: string, folder: string): string {
  const f = cleanRel(folder);
  if (f === null) throw new VaultError("That folder isn't in this workspace.");
  if (f && !(existsSync(absIn(root, f)) && statSync(absIn(root, f)).isDirectory())) throw new VaultError("That folder doesn't exist any more.");
  return f;
}

/** A new note in a folder, named from the title ("Alpha.md", then "Alpha 2.md"). */
export function createVaultNote(root: string, folder: string, title: string, body = ""): string {
  const f = folderOrThrow(root, folder);
  const rel = freePath(root, f, safeName(title), ".md");
  writeFileSync(absIn(root, rel), body, { flag: "wx" });
  return rel;
}

export function createVaultFolder(root: string, parent: string, name: string): string {
  const f = folderOrThrow(root, parent);
  const rel = freePath(root, f, safeName(name, "New folder"), "");
  mkdirSync(absIn(root, rel));
  return rel;
}

/** Rename or move a note or folder. Notes keep their .md. Never overwrites. */
export function renameVaultEntry(root: string, from: string, to: string): string {
  const a = cleanRel(from), bRaw = cleanRel(to);
  if (!a || !bRaw) throw new VaultError("That name can't be used.");
  const absA = absIn(root, a);
  if (!existsSync(absA)) throw new VaultError("It isn't there any more.");
  const isDir = statSync(absA).isDirectory();
  const b = !isDir && !isNote(bRaw) ? `${bRaw}${extname(a) || ".md"}` : bRaw;
  if (b === a) return a;
  if (isDir && (b + "/").startsWith(a + "/")) throw new VaultError("A folder can't go inside itself.");
  const absB = absIn(root, b);
  const parent = dirname(absB);
  if (!existsSync(parent) || !statSync(parent).isDirectory()) throw new VaultError("That folder doesn't exist.");
  // Case-only renames on a case-insensitive disk are fine; anything else must be free.
  if (existsSync(absB) && a.toLowerCase() !== b.toLowerCase()) throw new VaultError(`“${basename(b)}” already exists there.`);
  renameSync(absA, absB);
  return b;
}

export function moveVaultEntry(root: string, from: string, toFolder: string): string {
  const a = cleanRel(from);
  if (!a) throw new VaultError("Nothing to move.");
  const f = folderOrThrow(root, toFolder);
  return renameVaultEntry(root, a, f ? `${f}/${basename(a)}` : basename(a));
}

/** Delete = move into <folder>/.trash, keeping its path there ("x 2.md" when the name is taken). */
export function trashVaultEntry(root: string, rel: string): string {
  const a = cleanRel(rel);
  if (!a) throw new VaultError("Nothing to delete.");
  const absA = absIn(root, a);
  if (!existsSync(absA)) throw new VaultError("It isn't there any more.");
  const dir = posix.dirname(a) === "." ? "" : posix.dirname(a);
  const trashDir = join(root, TRASH, dir);
  mkdirSync(trashDir, { recursive: true });
  const ext = statSync(absA).isDirectory() ? "" : extname(a);
  const stem = basename(a, ext);
  let target = "";
  for (let n = 1; n < 1000; n++) {
    const name = `${stem}${n > 1 ? ` ${n}` : ""}${ext}`;
    if (!existsSync(join(trashDir, name))) { target = join(trashDir, name); break; }
  }
  if (!target) throw new VaultError("The trash is full of that name.");
  renameSync(absA, target);
  return toPosix(relative(root, target));
}

// ---------- links between notes ----------

/**
 * Find the note a link or path names: "notes/q4-plan.md", "Projects/Alpha", or a bare "Alpha"
 * (Obsidian style: the first note with that name anywhere, nearest first).
 */
export function resolveNotePath(root: string, input: string, files?: FileEntry[]): string | null {
  const raw = input.trim().replace(/#.*$/, "").replace(/\|.*$/, "");
  const clean = cleanRel(raw);
  if (clean) {
    for (const cand of [clean, `${clean}.md`]) {
      if (isNote(cand) && readVaultNote(root, cand)) return cand;
    }
    if (/^[\p{L}\p{N}][\p{L}\p{N}-]{0,79}$/u.test(clean) && readVaultNote(root, `notes/${clean}.md`)) return `notes/${clean}.md`;
  }
  if (!raw || raw.includes("/")) return null;
  const want = raw.replace(MD_RE, "").toLowerCase();
  const list = (files ?? walkVault(root).files).slice().sort((x, y) => x.path.split("/").length - y.path.split("/").length || x.path.localeCompare(y.path));
  return list.find((f) => noteName(f.path).toLowerCase() === want)?.path ?? null;
}

/** An attachment (image) by bare name anywhere, Obsidian style, nearest to `from` first. */
export function resolveAssetPath(root: string, name: string, from = ""): string | null {
  const clean = cleanRel(name);
  if (clean && ASSET_RE.test(clean)) {
    const here = from ? posix.join(from, clean) : clean;
    for (const cand of [here, clean]) {
      try { if (statSync(absIn(root, cand)).isFile()) return cand; } catch { /* try the next */ }
    }
  }
  if (!clean || clean.includes("/") || !ASSET_RE.test(clean)) return null;
  // A shallow search, so a huge folder doesn't stall an image.
  const want = clean.toLowerCase();
  const queue: string[] = [""];
  let seen = 0;
  while (queue.length && seen < 4000) {
    const dir = queue.shift()!;
    let entries: Dirent[] = [];
    try { entries = readdirSync(join(root, dir), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      seen++;
      if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) queue.push(rel);
      else if (e.isFile() && e.name.toLowerCase() === want) return rel;
    }
  }
  return null;
}
