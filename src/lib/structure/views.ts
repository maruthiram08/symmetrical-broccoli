// Saved views over notes and items: filter, sort and group, shown as a Table or a Kanban.
// Stored per workspace in the store (AppStore.listViews). Pure: rows come in, groups go out.
import { hasTag } from "./tag-core";
import type { PropValue } from "./frontmatter";

export type ViewSource = "notes" | "items";
export type ViewLayout = "table" | "kanban";
export const FILTER_OPS = ["is", "is_not", "contains", "has", "empty", "not_empty", "before", "after"] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export interface ViewFilter { field: string; op: FilterOp; value?: string }
export interface ViewSort { field: string; dir: "asc" | "desc" }

export interface SavedView {
  id: string;
  name: string;
  source: ViewSource;
  layout: ViewLayout;
  filters: ViewFilter[];
  sort: ViewSort | null;
  /** Field to group by (Table sections, Kanban columns). Null: one group. */
  group: string | null;
  /** Table columns; missing means the defaults for the source. */
  columns?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface NoteRow {
  slug: string;
  title: string;
  updatedAt: string;
  /** The note type's id, when it has a known one. */
  type: string | null;
  typeName: string | null;
  tags: string[];
  props: Record<string, PropValue>;
  /** Properties that aren't simple values (nested, multi-line): shown, never edited here. */
  rawKeys?: string[];
}

export interface ItemRow {
  id: string;
  text: string;
  kind: "owe" | "waiting" | "decision";
  status: "open" | "done" | "wrong" | "inbox";
  person: string | null;
  /** Project note slug. */
  project: string | null;
  tags: string[];
  dueAt: string | null;
  createdAt: string;
  manual: boolean;
}

export type Row = NoteRow | ItemRow;

export const ITEM_FIELDS = ["text", "kind", "status", "person", "project", "tag", "due", "created"] as const;
export const NOTE_FIELDS = ["title", "type", "tag", "updated"] as const;

export const FIELD_LABEL: Record<string, string> = {
  text: "Item", kind: "Kind", status: "Status", person: "Person", project: "Project", tag: "Tags", due: "Due", created: "Added",
  title: "Note", type: "Type", updated: "Updated",
};
export const fieldLabel = (f: string) => FIELD_LABEL[f] ?? (f.startsWith("prop:") ? f.slice(5) : f);

export const KIND_LABEL: Record<ItemRow["kind"], string> = { owe: "You owe", waiting: "Waiting on", decision: "Decision" };
export const STATUS_LABEL: Record<ItemRow["status"], string> = { open: "Open", done: "Done", wrong: "Wrong", inbox: "Inbox" };

/** A project slug as words, where its title isn't at hand: "q4-launch" -> "q4 launch". */
export const projectLabel = (slug: string) => slug.replace(/-/g, " ");

export const isNoteRow = (r: Row): r is NoteRow => "slug" in r;

/** A field's value on a row. Dates come back as "YYYY-MM-DD..." strings, tags as a list. */
export function fieldValue(r: Row, field: string): PropValue {
  if (isNoteRow(r)) {
    switch (field) {
      case "title": return r.title;
      case "type": return r.typeName;
      case "tag": return r.tags;
      case "updated": return r.updatedAt;
      default: return field.startsWith("prop:") ? r.props[field.slice(5)] ?? null : null;
    }
  }
  switch (field) {
    case "text": return r.text;
    case "kind": return r.kind;
    case "status": return r.status;
    case "person": return r.person;
    case "project": return r.project;
    case "tag": return r.tags;
    case "due": return r.dueAt;
    case "created": return r.createdAt;
    default: return null;
  }
}

const str = (v: PropValue) => (v === null ? "" : Array.isArray(v) ? v.join(", ") : String(v));
const low = (v: PropValue) => str(v).toLowerCase();
const isEmpty = (v: PropValue) => v === null || v === "" || (Array.isArray(v) && v.length === 0);
/** "[[person:Nitin]]" and "Nitin" compare equal. */
const plain = (s: string) => s.toLowerCase().replace(/^\[\[(?:[a-z]+:)?([^|\]]+)(?:\|[^\]]*)?\]\]$/, "$1").trim();

export function matchesFilter(r: Row, f: ViewFilter): boolean {
  const v = fieldValue(r, f.field);
  const want = (f.value ?? "").trim();
  switch (f.op) {
    case "empty": return isEmpty(v);
    case "not_empty": return !isEmpty(v);
    case "has": return Array.isArray(v) ? (f.field === "tag" ? hasTag(v, want.toLowerCase().replace(/^#/, "")) : v.some((x) => plain(x) === plain(want))) : plain(str(v)) === plain(want);
    case "is": return Array.isArray(v) ? v.some((x) => plain(x) === plain(want)) : plain(str(v)) === plain(want);
    case "is_not": return Array.isArray(v) ? !v.some((x) => plain(x) === plain(want)) : plain(str(v)) !== plain(want);
    case "contains": return low(v).includes(want.toLowerCase());
    case "before": return !isEmpty(v) && str(v).slice(0, 10) < want;
    case "after": return !isEmpty(v) && str(v).slice(0, 10) > want;
  }
}

function compare(a: PropValue, b: PropValue): number {
  if (isEmpty(a) && isEmpty(b)) return 0;
  if (isEmpty(a)) return 1; // empty last, either way
  if (isEmpty(b)) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return str(a).localeCompare(str(b), undefined, { numeric: true, sensitivity: "base" });
}

export function sortRows<T extends Row>(rows: T[], sort: ViewSort | null): T[] {
  if (!sort) return rows;
  const dir = sort.dir === "desc" ? -1 : 1;
  return rows.map((r, i) => [r, i] as const).sort(([a, i], [b, j]) => {
    const va = fieldValue(a, sort.field), vb = fieldValue(b, sort.field);
    if (isEmpty(va) !== isEmpty(vb)) return isEmpty(va) ? 1 : -1;
    return dir * compare(va, vb) || i - j;
  }).map(([r]) => r);
}

export interface Group<T extends Row = Row> {
  /** The value rows in it have ("" for none). */
  key: string;
  label: string;
  rows: T[];
}

/** Fixed Kanban columns for some fields, so empty ones still show (and can be dropped on). */
export function fixedColumns(source: ViewSource, field: string): Array<{ key: string; label: string }> | null {
  if (source !== "items") return null;
  if (field === "status") return (["open", "done", "wrong"] as const).map((k) => ({ key: k, label: STATUS_LABEL[k] }));
  if (field === "kind") return (["owe", "waiting", "decision"] as const).map((k) => ({ key: k, label: KIND_LABEL[k] }));
  return null;
}

function groupKey(r: Row, field: string): string {
  const v = fieldValue(r, field);
  if (Array.isArray(v)) return v[0] ?? "";
  if (field === "due" || field === "created" || field === "updated") return str(v).slice(0, 10);
  return str(v);
}

/** Filter, sort and group rows for a view. `labels` names group keys (project slugs to titles). */
export function applyView<T extends Row>(view: Pick<SavedView, "source" | "filters" | "sort" | "group">, rows: T[], labels: (field: string, key: string) => string = (_f, k) => k): Group<T>[] {
  const kept = sortRows(rows.filter((r) => view.filters.every((f) => matchesFilter(r, f))), view.sort);
  if (!view.group) return [{ key: "", label: "", rows: kept }];
  const field = view.group;
  const fixed = fixedColumns(view.source, field);
  const groups = new Map<string, Group<T>>();
  for (const c of fixed ?? []) groups.set(c.key, { key: c.key, label: c.label, rows: [] });
  for (const r of kept) {
    const k = groupKey(r, field);
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { key: k, label: k ? displayKey(field, k, labels) : `No ${fieldLabel(field).toLowerCase()}`, rows: [] }));
    g.rows.push(r);
  }
  const out = [...groups.values()];
  if (fixed) {
    // Inbox items only get a column when there are some.
    return out.filter((g) => g.rows.length || fixed.some((c) => c.key === g.key));
  }
  return out.sort((a, b) => (a.key === "" ? 1 : b.key === "" ? -1 : a.label.localeCompare(b.label, undefined, { numeric: true })));
}

function displayKey(field: string, key: string, labels: (field: string, key: string) => string): string {
  if (field === "kind") return KIND_LABEL[key as ItemRow["kind"]] ?? key;
  if (field === "status") return STATUS_LABEL[key as ItemRow["status"]] ?? key;
  if (field === "tag") return `#${key}`;
  return labels(field, key).replace(/^\[\[(?:[a-z]+:)?([^|\]]+)(?:\|([^\]]*))?\]\]$/, (_m, t: string, l?: string) => l ?? t);
}

/** Columns a table shows when the view names none. Notes add their property keys (up to 5). */
export function defaultColumns(source: ViewSource, rows: Row[]): string[] {
  if (source === "items") return ["text", "kind", "status", "person", "project", "tag", "due"];
  const keys: string[] = [];
  for (const r of rows) if (isNoteRow(r)) for (const k of Object.keys(r.props)) if (k !== "type" && k !== "tags" && !keys.includes(k)) keys.push(k);
  return ["title", "type", ...keys.slice(0, 5).map((k) => `prop:${k}`), "tag", "updated"];
}

/** Whether a Kanban grouped by this field can move a card by dropping it in another column. */
export function canDragOn(source: ViewSource, field: string | null): boolean {
  if (!field) return false;
  if (source === "items") return field === "status" || field === "project" || field === "kind";
  return field.startsWith("prop:") || field === "type";
}

const FIELD = /^(?:text|kind|status|person|project|tag|due|created|title|type|updated|prop:[^\s]{1,40})$/;

/** A view from the store or a form, checked. Null when it isn't usable. */
export function cleanView(v: Partial<SavedView> & { id: string }, now: string): SavedView | null {
  const source: ViewSource = v.source === "notes" ? "notes" : v.source === "items" ? "items" : (null as never);
  if (!source) return null;
  const name = String(v.name ?? "").trim().slice(0, 60);
  if (!name) return null;
  const filters = (Array.isArray(v.filters) ? v.filters : [])
    .filter((f) => f && FIELD.test(String(f.field)) && (FILTER_OPS as readonly string[]).includes(f.op))
    .slice(0, 12)
    .map((f) => ({ field: String(f.field), op: f.op, ...(f.value !== undefined && f.value !== "" ? { value: String(f.value).slice(0, 200) } : {}) }));
  const sort = v.sort && FIELD.test(String(v.sort.field)) ? { field: String(v.sort.field), dir: v.sort.dir === "desc" ? "desc" as const : "asc" as const } : null;
  const group = v.group && FIELD.test(String(v.group)) ? String(v.group) : null;
  const columns = Array.isArray(v.columns) ? v.columns.map(String).filter((c) => FIELD.test(c)).slice(0, 12) : undefined;
  return {
    id: v.id, name, source, layout: v.layout === "kanban" ? "kanban" : "table", filters, sort, group,
    ...(columns?.length ? { columns } : {}),
    createdAt: v.createdAt ?? now, updatedAt: now,
  };
}

/** Starter views offered on /views. */
export function starterViews(): Array<Omit<SavedView, "id" | "createdAt" | "updatedAt">> {
  return [
    { name: "Open by project", source: "items", layout: "kanban", filters: [{ field: "status", op: "is", value: "open" }, { field: "kind", op: "is_not", value: "decision" }], sort: { field: "due", dir: "asc" }, group: "project" },
    { name: "Projects", source: "notes", layout: "table", filters: [{ field: "type", op: "is", value: "Project" }], sort: { field: "title", dir: "asc" }, group: null },
  ];
}
