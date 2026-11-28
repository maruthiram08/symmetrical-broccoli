"use client";

// A note's YAML front matter as editable properties: text, number, date, checkbox, list and links
// to a person or note. Edits change only the lines of the property you edit (setProperties), so
// the rest of the front matter stays exactly as written.
import Link from "next/link";
import { useEffect, useId, useMemo, useState } from "react";
import { personSlug } from "@/lib/people";
import { dropEmptyFrontMatter, readEntries, setProperties, splitFrontMatter, type PropEntry, type PropValue } from "@/lib/structure/frontmatter";
import { coerce, PROP_TYPES, propTypeFor, typeOf, type NoteType, type PropType } from "@/lib/structure/note-types";
import { tagHref } from "@/lib/structure/tag-core";

export interface LinkChoice { kind: "person" | "note"; target: string; label: string }

const TYPE_LABEL: Record<PropType, string> = { text: "Text", number: "Number", date: "Date", checkbox: "Checkbox", list: "List", link: "Link" };

/** Apply property changes to the front matter only; `body` decides line endings for a new block. */
export function changeFrontMatter(fm: string, body: string, changes: Record<string, PropValue | undefined>): string {
  return splitFrontMatter(dropEmptyFrontMatter(setProperties(fm + body, changes))).raw;
}

export function PropertiesPanel(p: {
  fm: string;
  body: string;
  types: NoteType[];
  links: LinkChoice[];
  tags: string[];
  onChange: (fm: string) => void;
  status?: string | null;
}) {
  const entries = useMemo(() => readEntries(p.fm), [p.fm]);
  const props = useMemo(() => Object.fromEntries(entries.map((e) => [e.key, e.value])), [entries]);
  const type = typeOf(props, p.types);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState(entries.length > 0);
  const ids = useId();
  useEffect(() => { if (entries.length) setOpen(true); }, [entries.length]);

  const change = (changes: Record<string, PropValue | undefined>) => p.onChange(changeFrontMatter(p.fm, p.body, changes));

  const setType = (id: string) => {
    const t = p.types.find((x) => x.id === id) ?? null;
    const changes: Record<string, PropValue | undefined> = { type: t ? t.name : undefined };
    // A new type brings its properties that the note doesn't have yet.
    for (const d of t?.properties ?? []) if (!(d.key in props)) changes[d.key] = d.default === undefined ? (d.type === "list" ? [] : d.type === "checkbox" ? false : null) : typeof d.default === "string" ? d.default.replace(/\{\{\s*(?:date|title)\s*\}\}/g, "") || null : d.default;
    change(changes);
  };

  const shown = entries.filter((e) => e.key !== "type");
  const missing = (type?.properties ?? []).filter((d) => !(d.key in props));

  if (!open && !entries.length) {
    return (
      <div className="st-props st-props--closed">
        <button type="button" className="st-props__add" onClick={() => setOpen(true)}>+ Properties</button>
        {p.tags.length ? <TagChips tags={p.tags} /> : null}
      </div>
    );
  }

  return (
    <section className="st-props" aria-label="Properties">
      <div className="st-props__row">
        <label className="st-props__key" htmlFor={`${ids}-type`}>Type</label>
        <select id={`${ids}-type`} className="st-props__input st-props__select" value={type?.id ?? ""} onChange={(e) => setType(e.target.value)}>
          <option value="">{typeof props.type === "string" && !type ? `${props.type} (not a known type)` : "None"}</option>
          {p.types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <span className="st-props__end">{p.status ? <span className="st-props__status" aria-live="polite">{p.status}</span> : null}</span>
      </div>
      {shown.map((e) => (
        <PropRow key={e.key} entry={e} type={propTypeFor(e.key, e.value, type)} links={p.links} onSet={(v) => change({ [e.key]: v })} onRemove={() => change({ [e.key]: undefined })} />
      ))}
      {missing.length ? (
        <div className="st-props__row st-props__row--hint">
          <span className="st-props__key">More</span>
          <span className="st-props__missing">
            {missing.map((d) => (
              <button key={d.key} type="button" className="st-pill" onClick={() => change({ [d.key]: d.type === "list" ? [] : d.type === "checkbox" ? false : null })}>+ {d.key}</button>
            ))}
          </span>
        </div>
      ) : null}
      {adding ? <AddProp existing={Object.keys(props)} onAdd={(key, t) => { change({ [key]: t === "list" ? [] : t === "checkbox" ? false : t === "number" ? 0 : null }); setAdding(false); }} onCancel={() => setAdding(false)} /> : (
        <div className="st-props__row st-props__row--foot">
          <button type="button" className="st-props__add" onClick={() => setAdding(true)}>+ Add property</button>
          {p.tags.length ? <TagChips tags={p.tags} /> : null}
        </div>
      )}
      <datalist id="st-link-choices">
        {p.links.map((l) => <option key={`${l.kind}:${l.target}`} value={l.label}>{l.kind === "person" ? "Person" : "Note"}</option>)}
      </datalist>
    </section>
  );
}

function TagChips({ tags }: { tags: string[] }) {
  return (
    <span className="st-props__tags" aria-label="Tags">
      {tags.map((t) => <Link key={t} className="st-tag" href={tagHref(t)}>#{t}</Link>)}
    </span>
  );
}

function AddProp({ existing, onAdd, onCancel }: { existing: string[]; onAdd: (key: string, type: PropType) => void; onCancel: () => void }) {
  const [key, setKey] = useState("");
  const [type, setType] = useState<PropType>("text");
  const clean = key.trim().replace(/\s+/g, "_").slice(0, 40);
  const bad = !clean || clean === "type" || existing.includes(clean) || !/^[\p{L}\p{N}_][\p{L}\p{N}_.-]*$/u.test(clean);
  return (
    <form className="st-props__row st-props__new" onSubmit={(e) => { e.preventDefault(); if (!bad) onAdd(clean, type); }}>
      <input className="st-props__input st-props__keyin" autoFocus value={key} onChange={(e) => setKey(e.target.value)} placeholder="name" aria-label="Property name" maxLength={40} onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }} />
      <select className="st-props__input st-props__select" value={type} onChange={(e) => setType(e.target.value as PropType)} aria-label="Property type">
        {PROP_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
      </select>
      <button type="submit" className="db-act db-act--primary" disabled={bad}>Add</button>
      <button type="button" className="db-act" onClick={onCancel}>Cancel</button>
    </form>
  );
}

const str = (v: PropValue) => (v === null ? "" : Array.isArray(v) ? v.join(", ") : String(v));

const LINK = /^\[\[(?:(person|note|meeting|item|day):)?([^|\]\n]+)(?:\|([^\]\n]+))?\]\]$/i;

/** A [[link]] property value, read without the Markdown parser (which loads with the editor). */
function parseLink(v: string): { kind: string | null; target: string; label: string } | null {
  const m = v.trim().match(LINK);
  return m ? { kind: m[1]?.toLowerCase() ?? null, target: m[2].trim(), label: (m[3] ?? m[2]).trim() } : null;
}

function hrefOf(l: { kind: string | null; target: string }, links: LinkChoice[]): string {
  if (l.kind === "note") return `/notes/${encodeURIComponent(l.target)}`;
  if (l.kind === "item") return `/item/${encodeURIComponent(l.target)}`;
  if (l.kind === "day") return `/day/${encodeURIComponent(l.target)}`;
  if (l.kind === null) {
    const note = links.find((x) => x.kind === "note" && (x.target === l.target || x.label.toLowerCase() === l.target.toLowerCase()));
    if (note) return `/notes/${encodeURIComponent(note.target)}`;
  }
  return `/people/${encodeURIComponent(personSlug(l.target))}`;
}

/** "[[person:Nitin]]" -> "Nitin" for the input. */
function linkLabel(v: string): string {
  return parseLink(v)?.label ?? v;
}

function toLink(input: string, links: LinkChoice[]): string | null {
  const s = input.trim();
  if (!s) return null;
  if (/^\[\[.+\]\]$/.test(s)) return s;
  const hit = links.find((l) => l.label.toLowerCase() === s.toLowerCase());
  if (hit) return hit.kind === "person" ? `[[person:${hit.target}]]` : `[[note:${hit.target}|${hit.label}]]`;
  return `[[${s}]]`;
}

function PropRow({ entry, type, links, onSet, onRemove }: { entry: PropEntry; type: PropType; links: LinkChoice[]; onSet: (v: PropValue) => void; onRemove: () => void }) {
  const id = useId();
  const v = entry.value;
  const initial = entry.kind === "raw" ? entry.text : type === "link" && typeof v === "string" ? linkLabel(v) : str(v);
  const [draft, setDraft] = useState(initial);
  useEffect(() => setDraft(initial), [initial]);
  const commit = () => {
    if (draft === initial) return;
    if (type === "link") onSet(toLink(draft, links));
    else onSet(draft.trim() === "" && type !== "list" ? null : coerce(type, draft));
  };
  const keys = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") { e.preventDefault(); commit(); (e.target as HTMLInputElement).blur(); }
    if (e.key === "Escape") { setDraft(initial); (e.target as HTMLInputElement).blur(); }
  };
  let input: React.ReactNode;
  if (entry.kind === "raw") {
    input = <span className="st-props__raw" title="Edit this one in the file: it isn't a simple value">{entry.text}</span>;
  } else if (type === "checkbox") {
    input = <input id={id} type="checkbox" className="st-props__check" checked={v === true} onChange={(e) => onSet(e.target.checked)} />;
  } else if (type === "date") {
    input = <input id={id} type="date" className="st-props__input" value={typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : ""} onChange={(e) => onSet(e.target.value || null)} />;
  } else {
    input = (
      <span className="st-props__val">
        <input
          id={id}
          className="st-props__input"
          type={type === "number" ? "number" : "text"}
          inputMode={type === "number" ? "decimal" : undefined}
          list={type === "link" ? "st-link-choices" : undefined}
          value={draft}
          placeholder={type === "list" ? "a, b, c" : type === "link" ? "Person or note" : "Empty"}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={keys}
        />
        {type === "link" && typeof v === "string" && parseLink(v) ? (
          <Link className="st-props__open" href={hrefOf(parseLink(v)!, links)} aria-label={`Open ${linkLabel(v)}`}>↗</Link>
        ) : null}
      </span>
    );
  }
  return (
    <div className="st-props__row">
      <label className="st-props__key" htmlFor={id} title={`${entry.key} · ${TYPE_LABEL[type]}`}>{entry.key}</label>
      {input}
      <button type="button" className="st-props__x" aria-label={`Remove ${entry.key}`} title="Remove" onClick={onRemove}>×</button>
    </div>
  );
}
