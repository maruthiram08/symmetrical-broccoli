"use client";

// One saved view: filter, sort and group bar, then the rows as a Table (sortable, with editable
// cells where it's safe) or a Kanban (drag a card to change the field the columns stand for).
// Changes to the view itself save on their own, a moment after you stop.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { deleteViewAction, saveViewAction, setFieldAction } from "@/app/structure-actions";
import type { PropValue } from "@/lib/structure/frontmatter";
import { tagHref } from "@/lib/structure/tag-core";
import {
  applyView, canDragOn, defaultColumns, fieldLabel, fieldValue, FILTER_OPS, isNoteRow, ITEM_FIELDS, KIND_LABEL, NOTE_FIELDS, STATUS_LABEL,
  type FilterOp, type ItemRow, type NoteRow, type Row, type SavedView, type ViewFilter,
} from "@/lib/structure/views";
import { Kanban, type Card } from "./Kanban";

const OP_LABEL: Record<FilterOp, string> = { is: "is", is_not: "is not", contains: "contains", has: "has", empty: "is empty", not_empty: "is not empty", before: "before", after: "after" };

export interface ViewContext {
  projects: Array<{ slug: string; title: string }>;
  types: string[];
  /** Property types for note columns (prop:key -> type). */
  propTypes: Record<string, string>;
  timeZone: string;
  now: string;
}

const short = (iso: string, tz: string) => new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: iso.length === 10 ? "UTC" : tz });

export function ViewEditor({ initial, rows, ctx }: { initial: SavedView; rows: Row[]; ctx: ViewContext }) {
  const router = useRouter();
  const [view, setView] = useState(initial);
  const [status, setStatus] = useState<string | null>(null);
  const [, start] = useTransition();
  const first = useRef(true);
  const projectTitle = useMemo(() => new Map(ctx.projects.map((p) => [p.slug, p.title])), [ctx.projects]);
  const labels = (field: string, key: string) => (field === "project" ? projectTitle.get(key) ?? key.replace(/-/g, " ") : key);

  // Save the view a moment after it changes.
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    setStatus("Saving…");
    const t = setTimeout(() => {
      start(async () => {
        const r = await saveViewAction(view).catch(() => ({ ok: false as const, error: "Couldn't reach Daily brief." }));
        setStatus(r.ok ? "Saved" : r.error);
        if (r.ok) router.refresh();
      });
    }, 500);
    return () => clearTimeout(t);
  }, [view, router]);

  const set = (patch: Partial<SavedView>) => setView((v) => ({ ...v, ...patch }));
  const effective = view.layout === "kanban" && !view.group ? { ...view, group: view.source === "items" ? "status" : "type" } : view;
  const groups = applyView(effective, rows, labels);
  const total = groups.reduce((n, g) => n + g.rows.length, 0);

  const propKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const r of rows) if (isNoteRow(r)) for (const k of Object.keys(r.props)) if (k !== "type") keys.add(`prop:${k}`);
    return [...keys].sort();
  }, [rows]);
  const fields: string[] = view.source === "items" ? [...ITEM_FIELDS] : [...NOTE_FIELDS, ...propKeys];
  const columns = (view.columns?.length ? view.columns : defaultColumns(view.source, groups.flatMap((g) => g.rows))).filter((c) => fields.includes(c) || c.startsWith("prop:"));

  const toggleSort = (field: string) => set({ sort: view.sort?.field === field ? (view.sort.dir === "asc" ? { field, dir: "desc" } : null) : { field, dir: "asc" } });

  const edit = async (rowId: string, field: string, value: string | boolean) => {
    const r = await setFieldAction(view.source, rowId, field, value).catch(() => ({ ok: false as const, error: "Couldn't reach Daily brief." }));
    if (!r.ok) setStatus(r.error); else router.refresh();
    return r;
  };

  return (
    <div className="st-view">
      <div className="st-view__head">
        <input className="st-view__name" value={view.name} onChange={(e) => set({ name: e.target.value })} aria-label="View name" maxLength={60} />
        <div className="st-seg" role="group" aria-label="Layout">
          <button type="button" aria-pressed={view.layout === "table"} onClick={() => set({ layout: "table" })}>Table</button>
          <button type="button" aria-pressed={view.layout === "kanban"} onClick={() => set({ layout: "kanban", group: view.group ?? (view.source === "items" ? "status" : "type") })}>Kanban</button>
        </div>
      </div>
      <p className="st-view__sub">
        <span>{view.source === "items" ? "Items" : "Notes"} · {total} {total === 1 ? "row" : "rows"}</span>
        {status ? <span className="st-view__status" aria-live="polite">{status}</span> : null}
      </p>

      <div className="st-bar" aria-label="Filter, sort and group">
        {view.filters.map((f, k) => (
          <span key={k} className="st-chip">
            <span>{fieldLabel(f.field)} {OP_LABEL[f.op]}{f.value ? ` ${valueLabel(f.field, f.value, labels)}` : ""}</span>
            <button type="button" aria-label="Remove filter" onClick={() => set({ filters: view.filters.filter((_x, i) => i !== k) })}>×</button>
          </span>
        ))}
        <AddFilter fields={fields} source={view.source} ctx={ctx} onAdd={(f) => set({ filters: [...view.filters, f] })} />
        <label className="st-bar__ctl">
          <span>Sort</span>
          <select value={view.sort?.field ?? ""} onChange={(e) => set({ sort: e.target.value ? { field: e.target.value, dir: view.sort?.dir ?? "asc" } : null })}>
            <option value="">None</option>
            {fields.map((f) => <option key={f} value={f}>{fieldLabel(f)}</option>)}
          </select>
          {view.sort ? <button type="button" className="st-bar__dir" aria-label={view.sort.dir === "asc" ? "Ascending" : "Descending"} onClick={() => set({ sort: { ...view.sort!, dir: view.sort!.dir === "asc" ? "desc" : "asc" } })}>{view.sort.dir === "asc" ? "↑" : "↓"}</button> : null}
        </label>
        <label className="st-bar__ctl">
          <span>Group</span>
          <select value={effective.group ?? ""} onChange={(e) => set({ group: e.target.value || null })}>
            {view.layout === "table" ? <option value="">None</option> : null}
            {fields.filter((f) => !["text", "title", "updated", "created"].includes(f)).map((f) => <option key={f} value={f}>{fieldLabel(f)}</option>)}
          </select>
        </label>
      </div>

      {view.layout === "kanban" ? (
        <Kanban
          label={view.name}
          movable={canDragOn(view.source, effective.group)}
          columns={groups.map((g) => ({ key: g.key, label: g.label, cards: g.rows.map((r) => cardOf(r, ctx, projectTitle, effective.group)) }))}
          onMove={(id, to) => edit(id, effective.group!, to)}
        />
      ) : (
        <div className="st-tablewrap">
          {groups.map((g) => (
            <div key={g.key || "_"} className="st-tgroup">
              {view.group ? <h3 className="st-tgroup__head">{g.label} <span className="db-section__count">{g.rows.length}</span></h3> : null}
              <table className="st-table">
                <thead>
                  <tr>
                    {columns.map((c) => (
                      <th key={c} scope="col" aria-sort={view.sort?.field === c ? (view.sort.dir === "asc" ? "ascending" : "descending") : undefined}>
                        <button type="button" onClick={() => toggleSort(c)}>{fieldLabel(c)}{view.sort?.field === c ? (view.sort.dir === "asc" ? " ↑" : " ↓") : ""}</button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {g.rows.map((r) => (
                    <tr key={isNoteRow(r) ? r.slug : r.id}>
                      {columns.map((c) => <td key={c}><Cell row={r} field={c} ctx={ctx} projectTitle={projectTitle} onEdit={edit} /></td>)}
                    </tr>
                  ))}
                  {!g.rows.length ? <tr><td colSpan={columns.length} className="st-table__empty">Nothing matches.</td></tr> : null}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}

      <div className="st-view__foot">
        <button type="button" className="db-act db-act--danger" onClick={() => {
          if (!confirm(`Delete the view “${view.name}”? Notes and items stay.`)) return;
          start(async () => { await deleteViewAction(view.id); router.push("/views"); });
        }}>Delete view</button>
      </div>
    </div>
  );
}

function valueLabel(field: string, v: string, labels: (f: string, k: string) => string): string {
  if (field === "status") return STATUS_LABEL[v as ItemRow["status"]] ?? v;
  if (field === "kind") return KIND_LABEL[v as ItemRow["kind"]] ?? v;
  if (field === "tag") return `#${v.replace(/^#/, "")}`;
  return labels(field, v);
}

function AddFilter({ fields, source, ctx, onAdd }: { fields: string[]; source: SavedView["source"]; ctx: ViewContext; onAdd: (f: ViewFilter) => void }) {
  const [open, setOpen] = useState(false);
  const [field, setField] = useState(fields[0]);
  const [op, setOp] = useState<FilterOp>("is");
  const [value, setValue] = useState("");
  if (!open) return <button type="button" className="st-chip st-chip--add" onClick={() => setOpen(true)}>+ Filter</button>;
  const needs = op !== "empty" && op !== "not_empty";
  const dateField = field === "due" || field === "created" || field === "updated" || ctx.propTypes[field] === "date";
  const choices: Array<[string, string]> | null =
    field === "status" ? (Object.entries(STATUS_LABEL) as Array<[string, string]>)
    : field === "kind" ? (Object.entries(KIND_LABEL) as Array<[string, string]>)
    : field === "project" ? ctx.projects.map((p) => [p.slug, p.title])
    : field === "type" ? ctx.types.map((t) => [t, t])
    : null;
  return (
    <form className="st-addfilter" onSubmit={(e) => { e.preventDefault(); if (!needs || value.trim()) { onAdd({ field, op, ...(needs ? { value: value.trim() } : {}) }); setOpen(false); setValue(""); } }}>
      <select value={field} onChange={(e) => { setField(e.target.value); setValue(""); setOp(e.target.value === "tag" ? "has" : "is"); }} aria-label="Field">
        {fields.map((f) => <option key={f} value={f}>{fieldLabel(f)}</option>)}
      </select>
      <select value={op} onChange={(e) => setOp(e.target.value as FilterOp)} aria-label="Condition">
        {FILTER_OPS.filter((o) => (dateField ? o !== "contains" && o !== "has" : o !== "before" && o !== "after") && (o !== "has" || field === "tag" || source === "notes")).map((o) => <option key={o} value={o}>{OP_LABEL[o]}</option>)}
      </select>
      {needs ? (choices ? (
        <select value={value} onChange={(e) => setValue(e.target.value)} aria-label="Value">
          <option value="">Pick…</option>
          {choices.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      ) : <input type={dateField && (op === "before" || op === "after") ? "date" : "text"} value={value} onChange={(e) => setValue(e.target.value)} aria-label="Value" placeholder={field === "tag" ? "launch" : "value"} autoFocus />) : null}
      <button type="submit" className="db-act db-act--primary">Add</button>
      <button type="button" className="db-act" onClick={() => setOpen(false)}>Cancel</button>
    </form>
  );
}

function cardOf(r: Row, ctx: ViewContext, projectTitle: Map<string, string>, group: string | null): Card {
  if (isNoteRow(r)) return { id: r.slug, title: r.title, href: `/notes/${encodeURIComponent(r.slug)}`, sub: [r.typeName, short(r.updatedAt, ctx.timeZone)].filter(Boolean).join(" · "), tags: r.tags };
  const late = r.status === "open" && r.kind !== "decision" && !!r.dueAt && r.dueAt < ctx.now;
  const sub = [r.person, r.dueAt ? `due ${short(r.dueAt, ctx.timeZone)}` : null, r.project && group !== "project" ? projectTitle.get(r.project) ?? r.project : null].filter(Boolean).join(" · ");
  return { id: r.id, title: r.text, href: `/item/${encodeURIComponent(r.id)}`, sub: sub || KIND_LABEL[r.kind], mark: r.status !== "open" ? "done" : late ? "overdue" : r.kind, tags: r.tags };
}

const show = (v: PropValue) => (v === null ? "" : Array.isArray(v) ? v.join(", ") : typeof v === "boolean" ? (v ? "Yes" : "No") : String(v).replace(/^\[\[(?:[a-z]+:)?([^|\]]+)(?:\|([^\]]*))?\]\]$/, (_m, t: string, l?: string) => l ?? t));

/** One table cell: a link, plain text, or an editor where changing it is safe. */
function Cell({ row, field, ctx, projectTitle, onEdit }: { row: Row; field: string; ctx: ViewContext; projectTitle: Map<string, string>; onEdit: (id: string, field: string, v: string | boolean) => Promise<{ ok: boolean }> }) {
  const v = fieldValue(row, field);
  const id = isNoteRow(row) ? row.slug : row.id;
  const [local, setLocal] = useState<PropValue | undefined>(undefined);
  const cur = local === undefined ? v : local;
  const commit = (next: string | boolean) => { setLocal(typeof next === "boolean" ? next : next); void onEdit(id, field, next).then((r) => { if (!r.ok) setLocal(undefined); }); };

  if (isNoteRow(row)) return <NoteCell row={row} field={field} cur={cur} ctx={ctx} commit={commit} />;
  const item = row as ItemRow;
  switch (field) {
    case "text": return <Link className="st-cell__link" href={`/item/${encodeURIComponent(item.id)}`}>{item.text}</Link>;
    case "status":
      return (
        <select className="st-cell__sel" value={String(cur)} aria-label="Status" onChange={(e) => commit(e.target.value)}>
          {(item.kind === "decision" ? ["open", "wrong"] : ["open", "done", "wrong"]).map((s) => <option key={s} value={s}>{item.kind === "decision" && s === "open" ? "Decided" : STATUS_LABEL[s as ItemRow["status"]]}</option>)}
          {item.status === "inbox" ? <option value="inbox" disabled>Inbox</option> : null}
        </select>
      );
    case "kind":
      return item.manual && item.kind !== "decision"
        ? <select className="st-cell__sel" value={String(cur)} aria-label="Kind" onChange={(e) => commit(e.target.value)}><option value="owe">You owe</option><option value="waiting">Waiting on</option></select>
        : <span>{KIND_LABEL[item.kind]}</span>;
    case "project":
      return (
        <select className="st-cell__sel" value={String(cur ?? "")} aria-label="Project" onChange={(e) => commit(e.target.value)}>
          <option value="">None</option>
          {ctx.projects.map((p) => <option key={p.slug} value={p.slug}>{p.title}</option>)}
          {item.project && !projectTitle.has(item.project) ? <option value={item.project}>{item.project}</option> : null}
        </select>
      );
    case "tag": return <TagCell tags={Array.isArray(cur) ? cur : []} onSave={(s) => commit(s)} />;
    case "due": case "created": return <span className="st-cell__muted">{typeof v === "string" && v ? short(v, ctx.timeZone) : ""}</span>;
    default: return <span>{show(v)}</span>;
  }
}

function TagCell({ tags, onSave }: { tags: string[]; onSave: (s: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  if (!editing) {
    return (
      <span className="st-cell__tags">
        {tags.map((t) => <Link key={t} className="st-tag st-tag--quiet" href={tagHref(t)}>#{t}</Link>)}
        <button type="button" className="st-cell__edit" aria-label="Edit tags" onClick={() => { setDraft(tags.map((t) => `#${t}`).join(" ")); setEditing(true); }}>{tags.length ? "✎" : "+"}</button>
      </span>
    );
  }
  const done = () => { setEditing(false); if (draft.trim() !== tags.map((t) => `#${t}`).join(" ")) onSave(draft); };
  return <input className="st-cell__in" autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={done} onKeyDown={(e) => { if (e.key === "Enter") done(); if (e.key === "Escape") setEditing(false); }} aria-label="Tags" />;
}

function NoteCell({ row, field, cur, ctx, commit }: { row: NoteRow; field: string; cur: PropValue; ctx: ViewContext; commit: (v: string | boolean) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  if (field === "title") return <Link className="st-cell__link" href={`/notes/${encodeURIComponent(row.slug)}`}>{row.title}</Link>;
  if (field === "updated") return <span className="st-cell__muted">{short(row.updatedAt, ctx.timeZone)}</span>;
  if (field === "tag") return <span className="st-cell__tags">{row.tags.map((t) => <Link key={t} className="st-tag st-tag--quiet" href={tagHref(t)}>#{t}</Link>)}</span>;
  if (field === "type") {
    return (
      <select className="st-cell__sel" value={String(cur ?? "")} aria-label="Type" onChange={(e) => commit(e.target.value)}>
        <option value="">None</option>
        {ctx.types.map((t) => <option key={t} value={t}>{t}</option>)}
        {cur && !ctx.types.includes(String(cur)) ? <option value={String(cur)}>{String(cur)}</option> : null}
      </select>
    );
  }
  if (!field.startsWith("prop:")) return <span>{show(cur)}</span>;
  const t = ctx.propTypes[field] ?? (typeof cur === "boolean" ? "checkbox" : "text");
  if (t === "raw") return <span className="st-cell__muted" title="Edit this one in the note">{show(cur)}</span>;
  if (t === "checkbox") return <input type="checkbox" checked={cur === true} aria-label={fieldLabel(field)} onChange={(e) => commit(e.target.checked)} />;
  if (t === "date") {
    const value = typeof cur === "string" ? cur.slice(0, 10) : "";
    return <input type="date" className={`st-cell__in${value ? "" : " st-cell__in--empty"}`} value={value} aria-label={fieldLabel(field)} onChange={(e) => commit(e.target.value)} />;
  }
  const text = draft ?? show(cur);
  const done = () => { if (draft !== null && draft !== show(cur)) commit(draft); setDraft(null); };
  return <input className="st-cell__in" value={text} inputMode={t === "number" ? "decimal" : undefined} aria-label={fieldLabel(field)} onChange={(e) => setDraft(e.target.value)} onBlur={done} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setDraft(null); }} />;
}
