"use server";

// Properties, note types, tags, views and projects (src/lib/structure). Called from client
// components, which refresh after.
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { localDate } from "@/lib/brief/time";
import { coerce, propTypeFor, typeOf, type NoteType } from "@/lib/structure/note-types";
import { flatTags, parseTagList, tagTree } from "@/lib/structure/tags";
import { cleanView, type SavedView, type ViewSource } from "@/lib/structure/views";
import { getFileStore, getStore, me } from "@/server/local/app";
import { isHosted } from "@/server/mode";
import { autoFileProjects, recordFiling, recordFilings, removeProject } from "@/server/structure/autofile";
import { readPage, validSlug } from "@/server/local/pages";
import { loadNoteTypes, saveNoteTypes } from "@/server/structure/note-types";
import { createTypedNote, noteRows, projectRows, resolveProject, setNoteProperties } from "@/server/structure/notes";
import { readProperties, type PropValue } from "@/lib/structure/frontmatter";

type Fail = { ok: false; error: string };
const done = <T,>(r: T): T => { revalidatePath("/", "layout"); return r; };

export async function noteTypesAction(): Promise<NoteType[]> {
  if (!(await me())) return [];
  return loadNoteTypes().types;
}

/** "New note of type…": make the note and give back where it is. */
export async function createTypedNoteAction(typeId: string, title: string): Promise<{ ok: true; slug: string; title: string } | Fail> {
  const user = await me();
  if (!user) return { ok: false, error: "Set up Daily brief first." };
  const type = loadNoteTypes().types.find((t) => t.id === typeId);
  if (!type) return { ok: false, error: "That note type is gone." };
  const t = z.string().trim().max(120).safeParse(title);
  const name = (t.success && t.data) || `New ${type.name.toLowerCase()}`;
  const { slug } = createTypedNote(type, name, localDate(new Date(), user.timeZone));
  return done({ ok: true, slug, title: name });
}

/** The form on /notes/types: create a note of a type and open it. */
export async function createTypedNoteFormAction(formData: FormData): Promise<void> {
  const r = await createTypedNoteAction(String(formData.get("type") ?? ""), String(formData.get("title") ?? ""));
  const { redirect } = await import("next/navigation");
  if (r.ok) redirect(`/notes/${encodeURIComponent(r.slug)}`);
}

const PropDefZ = z.object({ key: z.string().trim().min(1).max(40), type: z.enum(["text", "number", "date", "checkbox", "list", "link"]), default: z.any().optional() });
const TypeZ = z.object({ id: z.string().max(40).optional(), name: z.string().trim().min(1).max(60), properties: z.array(PropDefZ).max(30), template: z.string().max(20_000) });

export async function saveNoteTypesAction(types: unknown): Promise<{ ok: true; types: NoteType[] } | Fail> {
  if (!(await me())) return { ok: false, error: "Set up Daily brief first." };
  const p = z.array(TypeZ).max(40).safeParse(types);
  if (!p.success) return { ok: false, error: p.error.issues[0]?.message ?? "Check the types." };
  const saved = saveNoteTypes(p.data.map((t) => ({ ...t, id: t.id ?? "" })) as NoteType[]);
  return done({ ok: true, types: saved });
}

// ---------- items: tags and project ----------

async function myItem(id: string) {
  const user = await me();
  if (!user || typeof id !== "string" || id.length > 100) return null;
  const item = (await getStore().listItems(user.id)).find((i) => i.id === id);
  return item ? { user, item } : null;
}

export async function projectsAction(): Promise<Array<{ slug: string; title: string }>> {
  if (!(await me())) return [];
  return projectRows().map((p) => ({ slug: p.slug, title: p.title }));
}

export async function setItemTagsAction(id: string, tags: string): Promise<{ ok: true; tags: string[] } | Fail> {
  const found = await myItem(id);
  if (!found || typeof tags !== "string" || tags.length > 500) return { ok: false, error: "That item is gone." };
  const list = parseTagList(tags).slice(0, 20);
  await getStore().updateItem(id, { tags: list });
  return done({ ok: true, tags: list });
}

/** Put an item in a project (a Project note's slug, or a new project's name), or take it out (""). */
export async function setItemProjectAction(id: string, project: string, opts: { create?: boolean } = {}): Promise<{ ok: true; project: string | null } | Fail> {
  const found = await myItem(id);
  if (!found || typeof project !== "string" || project.length > 120) return { ok: false, error: "That item is gone." };
  let slug: string | null = null;
  if (project.trim()) {
    if (opts.create) slug = await resolveProject(project, found.user.timeZone);
    else if (validSlug(project) && projectRows().some((p) => p.slug === project)) slug = project;
    else return { ok: false, error: "That project is gone." };
  }
  // A copy from before the change: the store hands out its own objects, and a correction needs
  // to know where the item was filed automatically.
  const was = { ...found.item };
  await getStore().updateItem(id, { project: slug, projectBy: "you", projectWhy: null });
  // Learn from it, and re-file the rest (local app: projects are notes on this Mac).
  if (!isHosted()) await recordFiling(getFileStore(), found.user.id, was, slug, new Date().toISOString()).catch(() => undefined);
  return done({ ok: true, project: slug });
}

/** "Looks right" on an automatic filing: keep it, and learn from it. */
export async function confirmItemProjectAction(id: string): Promise<{ ok: true } | Fail> {
  const found = await myItem(id);
  if (!found || !found.item.project) return { ok: false, error: "That item is gone." };
  return setItemProjectAction(id, found.item.project).then((r) => (r.ok ? { ok: true as const } : r));
}

/** Make a project from a topic your meetings share, seeded with it as a keyword, and file into it. */
export async function createProjectFromTopicAction(topic: string): Promise<{ ok: true; slug: string; filed: number; created: boolean } | Fail> {
  const user = await me();
  if (!user || isHosted()) return { ok: false, error: "Projects live on your Mac." };
  const name = typeof topic === "string" ? topic.trim().slice(0, 80) : "";
  if (!name) return { ok: false, error: "Give the project a name." };
  const existed = new Set(projectRows().map((p) => p.slug));
  const slug = await resolveProject(name, user.timeZone);
  if (!slug) return { ok: false, error: "Couldn't make that project." };
  const created = !existed.has(slug);
  const row = projectRows().find((p) => p.slug === slug);
  const had = Array.isArray(row?.props.keywords) ? (row!.props.keywords as string[]) : [];
  if (!had.map((k) => String(k).toLowerCase()).includes(name.toLowerCase())) setNoteProperties(slug, { keywords: [...had.map(String), name.toLowerCase()] });
  await autoFileProjects(getFileStore(), user.id);
  const filed = (await getStore().listItems(user.id)).filter((i) => i.project === slug).length;
  return done({ ok: true, slug, filed, created });
}

/**
 * Move several items at once into a project (a slug), or out of any project (""). Each counts as
 * your own filing, so automatic filing leaves them and learns from them.
 */
export async function moveItemsToProjectAction(ids: string[], project: string): Promise<{ ok: true; moved: number } | Fail> {
  const user = await me();
  if (!user) return { ok: false, error: "Set up Daily brief first." };
  if (!Array.isArray(ids) || !ids.length || ids.length > 500 || ids.some((id) => typeof id !== "string" || id.length > 100) || typeof project !== "string") return { ok: false, error: "Pick some items first." };
  let slug: string | null = null;
  if (project) {
    if (!validSlug(project) || !projectRows().some((p) => p.slug === project)) return { ok: false, error: "That project is gone." };
    slug = project;
  }
  const want = new Set(ids);
  const items = (await getStore().listItems(user.id)).filter((i) => want.has(i.id)).map((i) => ({ ...i }));
  if (!items.length) return { ok: false, error: "Those items are gone." };
  if (isHosted()) {
    for (const i of items) await getStore().updateItem(i.id, { project: slug, projectBy: "you", projectWhy: null });
    return done({ ok: true, moved: items.length });
  }
  const moved = await recordFilings(getFileStore(), user.id, items, slug, new Date().toISOString());
  return done({ ok: true, moved });
}

/**
 * Remove a project: everything in it goes back to "Needs a project" and the project gets nothing
 * new. `undo` is the Undo right after Make project: the note it just made is deleted too, instead
 * of archived.
 */
export async function removeProjectAction(slug: string, opts: { undo?: boolean } = {}): Promise<{ ok: true; cleared: number } | Fail> {
  const user = await me();
  if (!user || isHosted()) return { ok: false, error: "Projects live on your Mac." };
  if (typeof slug !== "string" || !validSlug(slug) || !projectRows().some((p) => p.slug === slug)) return { ok: false, error: "That project is gone." };
  const cleared = await removeProject(getFileStore(), user.id, slug, { deleteNote: !!opts.undo });
  return done({ ok: true, cleared });
}

/** "File again": re-run automatic filing now (after you edit a project's keywords, say). */
export async function refileProjectsAction(): Promise<{ ok: true; filed: number; unfiled: number } | Fail> {
  const user = await me();
  if (!user || isHosted()) return { ok: false, error: "Projects live on your Mac." };
  const r = await autoFileProjects(getFileStore(), user.id);
  return done({ ok: true, filed: r.filed, unfiled: r.unfiled });
}

/** The project page's Kanban: You owe, Waiting on, Done. */
export async function moveProjectItemAction(id: string, to: "owe" | "waiting" | "done"): Promise<{ ok: true } | Fail> {
  const found = await myItem(id);
  if (!found || !["owe", "waiting", "done"].includes(to)) return { ok: false, error: "That item is gone." };
  const { item } = found;
  const store = getStore();
  const at = new Date().toISOString();
  if (to === "done") {
    if (item.status !== "done") await store.setItemStatus(id, "done", at);
    return done({ ok: true });
  }
  if (item.kind !== to) {
    // What a meeting said can't change sides; your own items can.
    if (item.source !== "manual" || item.kind === "decision") return { ok: false, error: "Only items you added can move between You owe and Waiting on." };
    await store.updateItem(id, { kind: to });
  }
  if (item.status !== "open") await store.setItemStatus(id, "open", at);
  return done({ ok: true });
}

// ---------- views ----------

export async function listViewsAction(): Promise<SavedView[]> {
  const user = await me();
  return user ? getStore().listViews(user.id) : [];
}

export async function saveViewAction(input: Partial<SavedView>): Promise<{ ok: true; view: SavedView } | Fail> {
  const user = await me();
  if (!user) return { ok: false, error: "Set up Daily brief first." };
  const id = typeof input.id === "string" && /^[\w-]{1,40}$/.test(input.id) ? input.id : randomUUID().slice(0, 8);
  const existing = (await getStore().listViews(user.id)).find((v) => v.id === id);
  const v = cleanView({ ...input, id, createdAt: existing?.createdAt }, new Date().toISOString());
  if (!v) return { ok: false, error: "Give the view a name." };
  await getStore().saveView(user.id, v);
  return done({ ok: true, view: v });
}

/** The form on /views: a new view, then open it. */
export async function newViewFormAction(formData: FormData): Promise<void> {
  const source = formData.get("source") === "notes" ? "notes" : "items";
  const layout = formData.get("layout") === "kanban" ? "kanban" : "table";
  const starter = formData.get("starter");
  const r = await saveViewAction({
    name: String(formData.get("name") ?? "").trim() || (source === "notes" ? "Notes" : "Items"),
    source, layout,
    filters: source === "items" ? [{ field: "status", op: "is", value: "open" }, { field: "kind", op: "is_not", value: "decision" }] : [],
    sort: source === "items" ? { field: "due", dir: "asc" } : { field: "updated", dir: "desc" },
    group: layout === "kanban" ? (source === "items" ? "status" : "type") : null,
    ...(typeof starter === "string" && starter ? JSON.parse(starter) : {}),
  });
  const { redirect } = await import("next/navigation");
  if (r.ok) redirect(`/views/${encodeURIComponent(r.view.id)}`);
}

export async function deleteViewAction(id: string): Promise<{ ok: boolean }> {
  const user = await me();
  if (!user || typeof id !== "string") return { ok: false };
  const ok = await getStore().deleteView(user.id, id);
  return done({ ok });
}

/**
 * One table cell or Kanban drop. Items: status, project, kind (your own items), tags. Notes: a
 * property, or the type. Anything else is refused.
 */
export async function setFieldAction(source: ViewSource, rowId: string, field: string, value: string | boolean): Promise<{ ok: true } | Fail> {
  const user = await me();
  if (!user) return { ok: false, error: "Set up Daily brief first." };
  if (source === "items") {
    const found = await myItem(rowId);
    if (!found) return { ok: false, error: "That item is gone." };
    const store = getStore();
    const v = String(value);
    switch (field) {
      case "status":
        if (!["open", "done", "wrong"].includes(v)) return { ok: false, error: "Not a status." };
        if (found.item.kind === "decision" && v === "done") return { ok: false, error: "Decisions aren't done or open; mark one Wrong instead." };
        await store.setItemStatus(rowId, v as "open", new Date().toISOString());
        return done({ ok: true });
      case "project": {
        const r = await setItemProjectAction(rowId, v);
        return r.ok ? { ok: true } : r;
      }
      case "kind":
        if (!["owe", "waiting"].includes(v) || found.item.source !== "manual" || found.item.kind === "decision") return { ok: false, error: "Only items you added can change kind." };
        await store.updateItem(rowId, { kind: v as "owe" });
        return done({ ok: true });
      case "tag": {
        const r = await setItemTagsAction(rowId, v);
        return r.ok ? { ok: true } : r;
      }
      default:
        return { ok: false, error: "That column can't be changed here." };
    }
  }
  if (!validSlug(rowId)) return { ok: false, error: "That note is gone." };
  const page = readPage(rowId);
  if (!page) return { ok: false, error: "That note is gone." };
  const types = loadNoteTypes().types;
  if (field === "type") {
    const t = types.find((x) => x.id === value || x.name === value);
    const r = setNoteProperties(rowId, { type: value === "" ? undefined : t?.name ?? String(value) });
    return r && r.ok ? done({ ok: true }) : { ok: false, error: "Couldn't save the note." };
  }
  if (!field.startsWith("prop:")) return { ok: false, error: "That column can't be changed here." };
  const key = field.slice(5);
  if (!key || key === "type" || key.length > 40) return { ok: false, error: "That column can't be changed here." };
  const props = readProperties(page.markdown);
  const pt = propTypeFor(key, props[key] ?? null, typeOf(props, types));
  const next: PropValue = value === "" ? null : coerce(pt, typeof value === "boolean" ? value : String(value));
  const r = setNoteProperties(rowId, { [key]: next });
  return r && r.ok ? done({ ok: true }) : { ok: false, error: "Couldn't save the note." };
}

// ---------- Cmd+K ----------

export interface StructureNav {
  tags: Array<{ tag: string; count: number }>;
  views: Array<{ id: string; name: string; source: ViewSource }>;
  types: Array<{ id: string; name: string }>;
}

export async function structureNavAction(): Promise<StructureNav> {
  const user = await me();
  if (!user) return { tags: [], views: [], types: [] };
  const [items, views] = await Promise.all([getStore().listItems(user.id), getStore().listViews(user.id)]);
  const types = loadNoteTypes().types;
  const tree = tagTree({ notes: noteRows(undefined, types).map((n) => n.tags), items: items.filter((i) => i.status !== "wrong").map((i) => i.tags ?? []) });
  return {
    tags: flatTags(tree).slice(0, 200),
    views: views.map((v) => ({ id: v.id, name: v.name, source: v.source })),
    types: types.map((t) => ({ id: t.id, name: t.name })),
  };
}
