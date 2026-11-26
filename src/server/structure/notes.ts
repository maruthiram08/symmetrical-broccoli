// Notes as rows for tags, views and projects: each page's properties, type and tags.
import { readEntries, readProperties, setProperties, splitFrontMatter, type PropValue } from "@/lib/structure/frontmatter";
import { newNoteText, PROJECT_TYPE, typeOf, type NoteType } from "@/lib/structure/note-types";
import { findTags, propertyTags } from "@/lib/structure/tags";
import type { NoteRow } from "@/lib/structure/views";
import { createPage, listPages, readPage, savePage } from "@/server/local/pages";
import { notesDir } from "@/server/local/paths";
import { localDate } from "@/lib/brief/time";
import { noteSlug } from "@/lib/editor/links";
import { loadNoteTypes } from "./note-types";

/** A note's tags: #tags in the body and the `tags:` property. */
export function noteTags(md: string): string[] {
  const { body } = splitFrontMatter(md);
  const props = readProperties(md);
  return [...new Set([...propertyTags(props.tags ?? props.tag ?? null), ...findTags(body)])];
}

export function noteRow(slug: string, title: string, updatedAt: string, md: string, types: NoteType[]): NoteRow {
  const props = readProperties(md);
  const t = typeOf(props, types);
  const rawKeys = readEntries(splitFrontMatter(md).raw).filter((e) => e.kind === "raw").map((e) => e.key);
  return {
    slug, title, updatedAt, type: t?.id ?? null, typeName: t?.name ?? (typeof props.type === "string" ? props.type : null), tags: noteTags(md), props,
    ...(rawKeys.length ? { rawKeys } : {}),
  };
}

/** Every note in the current workspace as a row. */
export function noteRows(dir = notesDir(), types = loadNoteTypes().types): NoteRow[] {
  const out: NoteRow[] = [];
  for (const p of listPages(dir)) {
    const page = readPage(p.slug, dir);
    if (page) out.push(noteRow(p.slug, p.title, p.updatedAt, page.markdown, types));
  }
  return out;
}

/** Notes of type Project, by title. */
export function projectRows(rows = noteRows()): NoteRow[] {
  return rows.filter((r) => r.type === PROJECT_TYPE).sort((a, b) => a.title.localeCompare(b.title));
}

/** Make a note of a type: front matter with the type's defaults, then its template. */
export function createTypedNote(type: NoteType, title: string, date: string, dir = notesDir()): { slug: string } {
  const { slug } = createPage(title, dir);
  savePage(slug, newNoteText(type, title, date), null, dir);
  return { slug };
}

/**
 * Change properties of a note on disk, only the lines of those keys (see setProperties). `base` is
 * the hash the editor last saved: a note changed elsewhere since is kept as a conflict copy.
 */
export function setNoteProperties(slug: string, changes: Record<string, PropValue | undefined>, dir = notesDir()) {
  const page = readPage(slug, dir);
  if (!page) return null;
  const next = setProperties(page.markdown, changes);
  if (next === page.markdown) return { ok: true as const, hash: page.hash, markdown: next };
  const r = savePage(slug, next, page.hash, dir);
  return r.ok ? { ok: true as const, hash: r.hash, markdown: next } : r;
}

/**
 * The project a typed name means: an existing Project note by slug or title, else a new Project
 * note with that name. Null for an empty name.
 */
export function resolveProject(name: string, timeZone: string, dir = notesDir()): string | null {
  const n = name.trim().replace(/^\+/, "");
  if (!n) return null;
  const want = noteSlug(n);
  const projects = projectRows(noteRows(dir));
  const hit = projects.find((p) => p.slug === want || noteSlug(p.title) === want) ?? projects.find((p) => p.slug.startsWith(want));
  if (hit) return hit.slug;
  // A note with that slug that isn't a project yet becomes one.
  const page = readPage(want, dir);
  const type = loadNoteTypes().types.find((t) => t.id === PROJECT_TYPE);
  if (page) {
    setNoteProperties(want, { type: type?.name ?? "Project" }, dir);
    return want;
  }
  const title = n.replace(/[-_]+/g, " ").replace(/^./, (c) => c.toUpperCase());
  return createTypedNote(type ?? { id: PROJECT_TYPE, name: "Project", properties: [], template: "" }, title, localDate(new Date(), timeZone), dir).slug;
}

