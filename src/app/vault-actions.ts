"use server";

// The notes folder as a vault: the sidebar's tree and file operations, reading and saving any
// .md file in the workspace folder, embeds, backlinks, and making a missing day page.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { revalidatePath } from "next/cache";
import { backlinks, linksToNote, noteSlug, type Backlink, type LinkSource } from "@/lib/editor/links";
import { splitNotes } from "@/lib/capture/notes";
import { validDay } from "@/lib/dates/natural";
import { noteHref } from "@/lib/vault/layout";
import { me } from "@/server/local/app";
import { readDayNote } from "@/server/local/notes";
import { titleOf } from "@/server/local/pages";
import { notesDir } from "@/server/local/paths";
import {
  absIn, cleanRel, createVaultFolder, createVaultNote, folderPaths, moveVaultEntry, noteName, readVaultNote, renameVaultEntry,
  resolveNotePath, saveVaultNote, statVaultNote, trashVaultEntry, treeSignature, walkVault, TRASH, VaultError, type TreeNode, type VaultNote, type VaultSave,
} from "@/server/local/vault";
import { refreshVaultIndex, vaultIndexChanged, vaultTexts } from "@/server/local/vault-index";

type Done<T = object> = ({ ok: true } & T) | { ok: false; error: string };

const fail = (e: unknown): { ok: false; error: string } => ({ ok: false, error: e instanceof VaultError ? e.message : e instanceof Error && /EEXIST|ENOTEMPTY/.test(e.message) ? "Something with that name is already there." : "Couldn't do that." });

async function root(): Promise<string | null> {
  return (await me()) ? notesDir() : null;
}

function savedEntry(r: string, path: string) {
  try { const st = statSync(join(r, path)); return { path, mtimeMs: st.mtimeMs, size: st.size }; } catch { return null; }
}

export interface TreeResult { sig: string; tree?: TreeNode[]; folders?: string[]; truncated?: boolean }

/** The sidebar's tree. With the signature you have, nothing is sent back unless it changed. */
export async function vaultTreeAction(known?: string): Promise<TreeResult | null> {
  const r = await root();
  if (!r) return null;
  const { tree, files, truncated } = walkVault(r);
  const sig = treeSignature(files);
  if (known && known === sig) return { sig };
  return { sig, tree, folders: folderPaths(tree), truncated };
}

export async function readVaultNoteAction(path: string): Promise<VaultNote | null> {
  const r = await root();
  return r ? readVaultNote(r, path) : null;
}

export async function statVaultNoteAction(path: string): Promise<{ hash: string; mtimeMs: number } | null> {
  const r = await root();
  return r ? statVaultNote(r, path) : null;
}

/** Find the note behind a /notes/... link: a path, a slug in notes/, or a bare name. */
export async function resolveNoteAction(input: string): Promise<string | null> {
  const r = await root();
  if (!r || typeof input !== "string" || input.length > 1024) return null;
  return resolveNotePath(r, input);
}

export async function saveVaultNoteAction(path: string, markdown: string, base: string | null): Promise<VaultSave> {
  const r = await root();
  if (!r) return { ok: false, error: "Set up Daily brief first." };
  if (typeof markdown !== "string") return { ok: false, error: "Couldn't save." };
  try {
    const res = saveVaultNote(r, path, markdown, typeof base === "string" ? base : null);
    if (res.ok && res.written) {
      const e = savedEntry(r, cleanRel(path) ?? "");
      if (e) vaultIndexChanged(r, { saved: [e] });
    }
    return res;
  } catch (e) {
    return fail(e);
  }
}

export async function createVaultNoteAction(folder: string, title: string): Promise<Done<{ path: string }>> {
  const r = await root();
  if (!r) return { ok: false, error: "Set up Daily brief first." };
  try {
    const path = createVaultNote(r, folder, String(title ?? "").slice(0, 120));
    const e = savedEntry(r, path);
    if (e) vaultIndexChanged(r, { saved: [e] });
    revalidatePath("/notes");
    return { ok: true, path };
  } catch (e) {
    return fail(e);
  }
}

export async function createVaultFolderAction(parent: string, name: string): Promise<Done<{ path: string }>> {
  const r = await root();
  if (!r) return { ok: false, error: "Set up Daily brief first." };
  try { return { ok: true, path: createVaultFolder(r, parent, String(name ?? "").slice(0, 120)) }; } catch (e) { return fail(e); }
}

function reindexMoved(r: string, from: string) {
  vaultIndexChanged(r, { removed: [from] });
  refreshVaultIndex(r, { force: true });
}

/** Rename in place: only the name changes. */
export async function renameVaultEntryAction(path: string, name: string): Promise<Done<{ path: string }>> {
  const r = await root();
  if (!r) return { ok: false, error: "Set up Daily brief first." };
  const clean = cleanRel(path);
  const n = String(name ?? "").trim();
  if (!clean || !n || /[/\\]/.test(n) || n.startsWith(".")) return { ok: false, error: "Use a name without slashes or a leading dot." };
  const dir = clean.includes("/") ? clean.slice(0, clean.lastIndexOf("/")) : "";
  try {
    const to = renameVaultEntry(r, clean, dir ? `${dir}/${n}` : n);
    reindexMoved(r, clean);
    return { ok: true, path: to };
  } catch (e) {
    return fail(e);
  }
}

export async function moveVaultEntryAction(path: string, folder: string): Promise<Done<{ path: string }>> {
  const r = await root();
  if (!r) return { ok: false, error: "Set up Daily brief first." };
  try {
    const to = moveVaultEntry(r, path, folder);
    reindexMoved(r, path);
    return { ok: true, path: to };
  } catch (e) {
    return fail(e);
  }
}

/** Delete: into the workspace's .trash folder, so it can come back. */
export async function trashVaultEntryAction(path: string): Promise<Done<{ trashed: string }>> {
  const r = await root();
  if (!r) return { ok: false, error: "Set up Daily brief first." };
  try {
    const trashed = trashVaultEntry(r, path);
    vaultIndexChanged(r, { removed: [path] });
    revalidatePath("/notes");
    return { ok: true, trashed };
  } catch (e) {
    return fail(e);
  }
}

/** Undo a delete: put it back where it was, if that place is still free. */
export async function restoreVaultEntryAction(trashed: string, original: string): Promise<Done<{ path: string }>> {
  const r = await root();
  if (!r) return { ok: false, error: "Set up Daily brief first." };
  const inTrash = typeof trashed === "string" && trashed.startsWith(`${TRASH}/`) ? cleanRel(trashed.slice(TRASH.length + 1)) : null;
  const back = cleanRel(original);
  if (!inTrash || !back) return { ok: false, error: "Couldn't put it back." };
  try {
    const from = join(r, TRASH, inTrash);
    const to = absIn(r, back);
    if (!existsSync(from)) return { ok: false, error: "It isn't in the trash any more." };
    if (existsSync(to)) return { ok: false, error: "Something new is in its place now." };
    const { renameSync, mkdirSync } = await import("node:fs");
    mkdirSync(join(to, ".."), { recursive: true });
    renameSync(from, to);
    refreshVaultIndex(r, { force: true });
    return { ok: true, path: back };
  } catch (e) {
    return fail(e);
  }
}

/** What an ![[embed]] shows: the note's text (the start of it, for a long one). */
export async function vaultEmbedAction(target: string): Promise<{ title: string; markdown: string; href: string } | null> {
  const r = await root();
  if (!r || typeof target !== "string" || target.length > 300) return null;
  const path = resolveNotePath(r, target);
  const n = path ? readVaultNote(r, path) : null;
  if (!n) return null;
  return { title: titleOf(n.markdown, n.name), markdown: n.markdown.slice(0, 20_000), href: noteHref(n.path) };
}

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.md$/;

/** Notes anywhere in the folder that [[link]] to this one (by name, heading or path). */
export async function vaultBacklinksAction(path: string): Promise<Backlink[]> {
  const r = await root();
  const clean = cleanRel(path);
  if (!r || !clean) return [];
  try {
    const name = noteName(clean);
    const self = readVaultNote(r, clean);
    const heading = self ? titleOf(self.markdown, name) : name;
    const sources: LinkSource[] = [];
    for (const [p, text] of vaultTexts(r)) {
      if (!text.includes("[[")) continue;
      const day = p.match(DAY_FILE);
      if (day) { const notes = splitNotes(text).notes; if (notes) sources.push({ type: "day", id: day[1], title: day[1], markdown: notes }); continue; }
      sources.push({ type: "note", id: p, title: titleOf(text, noteName(p)), markdown: text });
    }
    const noExt = clean.replace(/\.md$/i, "");
    const list = backlinks(
      sources,
      (l) => linksToNote(l, { slug: noteSlug(name), title: name }) || linksToNote(l, { slug: noteSlug(heading), title: heading }) || l.target.replace(/\.md$/i, "") === noExt,
      { type: "note", id: clean },
    );
    return list.map((b) => (b.type === "note" ? { ...b, href: noteHref(b.id) } : b)).slice(0, 50);
  } catch {
    return [];
  }
}

/** Natural-language navigation: make the day's page when it doesn't exist yet, then open it. */
export async function createDayAction(date: string): Promise<{ ok: boolean; href?: string }> {
  const user = await me();
  if (!user || typeof date !== "string" || !validDay(date)) return { ok: false };
  if (!(await readDayNote(user.id, date))) {
    // An empty notes block would be dropped, so start the page with its heading only.
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const dir = notesDir();
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${date}.md`);
    if (!existsSync(path)) writeFileSync(path, `# ${date}\n`, { flag: "wx" });
  }
  revalidatePath("/", "layout");
  return { ok: true, href: `/day/${date}` };
}
