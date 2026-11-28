// What the structure pages (tags, views, projects) load: items and notes as rows, project titles
// and the people and notes a link property can point at.
import { isManual } from "@/lib/capture/items";
import { groupNames } from "@/lib/people";
import { flatTags, tagTree, type TagNode } from "@/lib/structure/tags";
import type { ItemRow, NoteRow } from "@/lib/structure/views";
import type { Item, User } from "@/lib/types";
import { listPages } from "@/server/local/pages";
import { loadNoteTypes } from "@/server/structure/note-types";
import { noteRows, projectRows } from "@/server/structure/notes";
import type { LinkChoice } from "@/components/structure/PropertiesPanel";
import type { Card } from "@/components/structure/Kanban";
import { loadAll, shortDate } from "./lines";

export function itemRow(i: Item): ItemRow {
  return {
    id: i.id, text: i.text, kind: i.kind, status: i.status, person: i.person, project: i.project ?? null,
    tags: i.tags ?? [], dueAt: i.dueAt, createdAt: i.createdAt, manual: isManual(i),
  };
}

export interface Structure {
  items: Item[];
  itemRows: ItemRow[];
  notes: NoteRow[];
  projects: Array<{ slug: string; title: string }>;
  projectTitle: (slug: string) => string;
  tree: TagNode[];
}

export async function loadStructure(user: User): Promise<Structure> {
  const { items } = await loadAll(user);
  const types = loadNoteTypes().types;
  const notes = noteRows(undefined, types);
  const projects = projectRows(notes).map((p) => ({ slug: p.slug, title: p.title }));
  const titles = new Map(notes.map((n) => [n.slug, n.title]));
  const live = items.filter((i) => i.status !== "wrong");
  return {
    items, itemRows: items.map(itemRow), notes, projects,
    projectTitle: (slug) => titles.get(slug) ?? slug.replace(/-/g, " "),
    tree: tagTree({ notes: notes.map((n) => n.tags), items: live.map((i) => i.tags ?? []) }),
  };
}

export const allTags = (s: Structure) => flatTags(s.tree).map((t) => t.tag);

/** People and notes for link properties. */
export async function linkChoices(user: User): Promise<LinkChoice[]> {
  const { items, people } = await loadAll(user);
  const out: LinkChoice[] = [];
  for (const g of groupNames(items.filter((i) => i.status !== "wrong").map((i) => i.person ?? "").filter(Boolean), [user.name, ...user.aliases], people)) {
    out.push({ kind: "person", target: g.name, label: g.name });
  }
  for (const p of people) if (!out.some((o) => o.label === p.name)) out.push({ kind: "person", target: p.name, label: p.name });
  for (const n of listPages()) out.push({ kind: "note", target: n.slug, label: n.title });
  return out;
}

const KIND = { owe: "You owe", waiting: "Waiting on", decision: "Decision" } as const;

/** An item as a Kanban card. */
export function itemCard(i: Item, user: User, now: Date, projectTitle?: (slug: string) => string): Card {
  const late = i.status === "open" && i.kind !== "decision" && !!i.dueAt && Date.parse(i.dueAt) < now.getTime();
  const bits = [i.person, i.dueAt ? `${late ? "was due" : "due"} ${shortDate(i.dueAt, user.timeZone)}` : null, projectTitle && i.project ? projectTitle(i.project) : null].filter(Boolean);
  return {
    id: i.id, title: i.text, href: `/item/${encodeURIComponent(i.id)}`, sub: bits.join(" · ") || KIND[i.kind],
    mark: i.status !== "open" ? "done" : late ? "overdue" : i.kind, tags: i.tags,
  };
}

/** A note as a Kanban card. */
export function noteCard(n: NoteRow, user: User): Card {
  return { id: n.slug, title: n.title, href: `/notes/${encodeURIComponent(n.slug)}`, sub: [n.typeName, shortDate(n.updatedAt, user.timeZone)].filter(Boolean).join(" · "), tags: n.tags };
}
