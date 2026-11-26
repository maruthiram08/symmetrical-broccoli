// Free-form notes: one Markdown file per page in <notes folder>/notes/<slug>.md. The file is the
// page: it is read and written byte for byte (no front matter, nothing added), so any editor can
// open it. The title is the first "# " heading, else the slug.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { noteSlug, type LinkSource } from "@/lib/editor/links";
import { splitNotes } from "@/lib/capture/notes";
import { notesDir } from "./paths";

export const pagesDir = (dir = notesDir()) => join(dir, "notes");
const SLUG = /^[\p{L}\p{N}][\p{L}\p{N}-]{0,79}$/u;
export const validSlug = (s: string) => SLUG.test(s);
const pagePath = (slug: string, dir: string) => join(pagesDir(dir), `${slug}.md`);

export const hashOf = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** "# Q4 plan" -> "Q4 plan"; else the slug with spaces. */
export function titleOf(md: string, slug: string): string {
  const m = md.replace(/^﻿/, "").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").match(/^\s*#\s+(.+?)\s*#*\s*$/m);
  const first = m && md.indexOf(m[0]) < 400 ? m[1].replace(/\[\[(?:[a-z]+:)?([^|\]]+)(?:\|([^\]]+))?\]\]/g, (_x, t, l) => l ?? t).trim() : "";
  return first || slug.replace(/-/g, " ");
}

export interface PageMeta { slug: string; title: string; updatedAt: string; bytes: number }

export function listPages(dir = notesDir()): PageMeta[] {
  const d = pagesDir(dir);
  if (!existsSync(d)) return [];
  const out: PageMeta[] = [];
  for (const f of readdirSync(d)) {
    if (!f.endsWith(".md")) continue;
    const slug = f.slice(0, -3);
    if (!validSlug(slug)) continue;
    const path = join(d, f);
    const st = statSync(path);
    if (!st.isFile()) continue;
    out.push({ slug, title: titleOf(readFileSync(path, "utf8"), slug), updatedAt: st.mtime.toISOString(), bytes: st.size });
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function readPage(slug: string, dir = notesDir()): { slug: string; title: string; markdown: string; hash: string } | null {
  if (!validSlug(slug)) return null;
  const path = pagePath(slug, dir);
  if (!existsSync(path)) return null;
  const markdown = readFileSync(path, "utf8");
  return { slug, title: titleOf(markdown, slug), markdown, hash: hashOf(markdown) };
}

function writeAtomic(path: string, text: string) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/** A new page from a title, with a free slug ("q4-plan", "q4-plan-2"...). */
export function createPage(title: string, dir = notesDir(), body = ""): { slug: string } {
  const base = noteSlug(title || "Untitled");
  mkdirSync(pagesDir(dir), { recursive: true });
  let slug = base;
  for (let n = 2; existsSync(pagePath(slug, dir)); n++) slug = `${base}-${n}`;
  writeAtomic(pagePath(slug, dir), `# ${(title || "Untitled").trim()}\n\n${body}`);
  return { slug };
}

export type SaveResult = { ok: true; hash: string; conflict?: string } | { ok: false; error: string };

/**
 * Save a page exactly as given. `base` is the hash of the text the editor started from: when the
 * file changed on disk since (edited in another app), that version is kept next to it as
 * <slug>.conflict-<time>.md instead of being lost, and the save still goes through.
 */
export function savePage(slug: string, markdown: string, base: string | null, dir = notesDir(), now = new Date()): SaveResult {
  if (!validSlug(slug)) return { ok: false, error: "That page name isn't valid." };
  if (markdown.length > 1_000_000) return { ok: false, error: "That page is too long to save." };
  mkdirSync(pagesDir(dir), { recursive: true });
  const path = pagePath(slug, dir);
  let conflict: string | undefined;
  if (existsSync(path)) {
    const disk = readFileSync(path, "utf8");
    const h = hashOf(disk);
    if (base && h !== base && disk !== markdown) {
      conflict = `${slug}.conflict-${now.toISOString().replace(/[:.]/g, "-")}.md`;
      writeAtomic(join(pagesDir(dir), conflict), disk);
    }
  }
  writeAtomic(path, markdown);
  return { ok: true, hash: hashOf(markdown), conflict };
}

export function deletePage(slug: string, dir = notesDir()): boolean {
  if (!validSlug(slug)) return false;
  const path = pagePath(slug, dir);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

/** Every note and daily note, for backlinks. Daily notes contribute only your notes part. */
export function linkSources(dir = notesDir()): LinkSource[] {
  const out: LinkSource[] = [];
  for (const p of listPages(dir)) {
    const page = readPage(p.slug, dir);
    if (page) out.push({ type: "note", id: p.slug, title: page.title, markdown: page.markdown });
  }
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      const m = f.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
      if (!m) continue;
      const notes = splitNotes(readFileSync(join(dir, f), "utf8")).notes;
      if (notes && notes.includes("[[")) out.push({ type: "day", id: m[1], title: m[1], markdown: notes });
    }
  }
  return out;
}
