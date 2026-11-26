// Note types: Meeting note, Project, Person note... Each has default properties and a template.
// Stored per workspace in .daily-brief/note-types.json (src/server/local/note-types.ts). A note's
// type is its `type:` property, matched by the type's name or id. Pure.
import { setProperties, type PropValue } from "./frontmatter";

export const PROP_TYPES = ["text", "number", "date", "checkbox", "list", "link"] as const;
export type PropType = (typeof PROP_TYPES)[number];

export interface PropDef {
  key: string;
  type: PropType;
  /** Written into a new note of this type. Text may use {{date}} and {{title}}. */
  default?: PropValue;
}

export interface NoteType {
  /** "project", "meeting", "person": stable, used in /new and URLs. */
  id: string;
  name: string;
  properties: PropDef[];
  /** The body of a new note after its "# Title" line. May use {{title}} and {{date}}. */
  template: string;
}

export interface NoteTypesFile {
  version: 1;
  types: NoteType[];
}

/** Projects are notes of this type (items point at them by slug). */
export const PROJECT_TYPE = "project";

export const DEFAULT_TYPES: NoteType[] = [
  {
    id: "meeting", name: "Meeting note",
    properties: [{ key: "date", type: "date", default: "{{date}}" }, { key: "attendees", type: "list", default: [] }, { key: "project", type: "link" }],
    template: "## Agenda\n\n- \n\n## Notes\n\n## Actions\n\n- [ ] \n",
  },
  {
    id: PROJECT_TYPE, name: "Project",
    properties: [{ key: "status", type: "text", default: "active" }, { key: "owner", type: "link" }, { key: "due", type: "date" }],
    template: "## Goal\n\n## Plan\n\n- \n",
  },
  {
    id: "person", name: "Person note",
    properties: [{ key: "person", type: "link" }, { key: "role", type: "text" }, { key: "met", type: "date" }],
    template: "## About\n\n## Talking points\n\n- \n",
  },
];

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** "Meeting note" -> "meeting-note". */
export function typeId(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "type";
}

const clean = (s: unknown, max: number) => (typeof s === "string" ? s.trim().slice(0, max) : "");

function cleanDefault(type: PropType, v: unknown): PropValue | undefined {
  if (v === undefined || v === null) return undefined;
  if (type === "list") return Array.isArray(v) ? v.map(String).slice(0, 50) : typeof v === "string" && v.trim() ? v.split(",").map((x) => x.trim()).filter(Boolean) : [];
  if (type === "checkbox") return v === true || v === "true";
  if (type === "number") { const n = Number(v); return Number.isFinite(n) ? n : undefined; }
  return typeof v === "string" ? v.slice(0, 200) : String(v);
}

/** A types file as read from disk, checked: bad entries are dropped, never fatal. */
export function parseTypes(json: unknown): NoteType[] {
  const list = (json as Partial<NoteTypesFile> | null)?.types;
  if (!Array.isArray(list)) return DEFAULT_TYPES;
  const out: NoteType[] = [];
  for (const t of list) {
    const name = clean(t?.name, 60);
    const id = ID.test(String(t?.id ?? "")) ? String(t.id) : typeId(name);
    if (!name || out.some((o) => o.id === id)) continue;
    const props: PropDef[] = [];
    for (const p of Array.isArray(t.properties) ? t.properties : []) {
      const key = clean(p?.key, 40);
      const type = (PROP_TYPES as readonly string[]).includes(p?.type) ? (p.type as PropType) : "text";
      if (!key || key === "type" || props.some((x) => x.key === key)) continue;
      const d = cleanDefault(type, p.default);
      props.push(d === undefined ? { key, type } : { key, type, default: d });
    }
    out.push({ id, name, properties: props.slice(0, 30), template: typeof t.template === "string" ? t.template.slice(0, 20_000) : "" });
  }
  return out;
}

/** Which type a note is, from its `type:` property. */
export function typeOf(props: Record<string, PropValue>, types: NoteType[]): NoteType | null {
  const v = props.type;
  if (typeof v !== "string" || !v.trim()) return null;
  const want = v.trim().toLowerCase();
  return types.find((t) => t.name.toLowerCase() === want || t.id === want) ?? null;
}

const fill = (s: string, vars: { title: string; date: string }) => s.replace(/\{\{\s*(title|date)\s*\}\}/g, (_m, k: "title" | "date") => vars[k]);

/** The Markdown of a new note of a type: front matter (type + defaults), "# Title", template. */
export function newNoteText(type: NoteType, title: string, date: string): string {
  const vars = { title, date };
  const props: Record<string, PropValue> = { type: type.name };
  for (const p of type.properties) {
    const d = p.default;
    props[p.key] = d === undefined ? (p.type === "list" ? [] : p.type === "checkbox" ? false : null) : typeof d === "string" ? fill(d, vars) : d;
  }
  return setProperties(`# ${title}\n\n${fill(type.template, vars)}`, props);
}

/** How a property should be edited: from the note's type, else guessed from its value. */
export function propTypeFor(key: string, value: PropValue, type: NoteType | null): PropType {
  const def = type?.properties.find((p) => p.key === key);
  if (def) return def.type;
  if (Array.isArray(value)) return "list";
  if (typeof value === "boolean") return "checkbox";
  if (typeof value === "number") return "number";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return "date";
  if (typeof value === "string" && /^\[\[[^[\]]+\]\]$/.test(value.trim())) return "link";
  return "text";
}

/** A value typed into the properties panel, as the property's type. */
export function coerce(type: PropType, input: string | boolean | string[]): PropValue {
  if (type === "checkbox") return input === true || input === "true";
  if (type === "list") return (Array.isArray(input) ? input : String(input).split(",")).map((x) => String(x).trim()).filter(Boolean);
  const s = String(input).trim();
  if (!s) return null;
  if (type === "number") { const n = Number(s); return Number.isFinite(n) ? n : s; }
  if (type === "date") return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : s;
  if (type === "link") return /^\[\[.+\]\]$/.test(s) ? s : `[[${s}]]`;
  return s;
}
