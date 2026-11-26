"use client";

// Settings for note types: name, default properties ("key: type = default", one per line) and the
// template. Saved to .daily-brief/note-types.json in this workspace.
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createTypedNoteAction, saveNoteTypesAction } from "@/app/structure-actions";
import { PROP_TYPES, type NoteType, type PropDef, type PropType } from "@/lib/structure/note-types";

interface Draft { id: string; name: string; props: string; template: string }

const propsText = (ps: PropDef[]) => ps.map((p) => `${p.key}: ${p.type}${p.default !== undefined && p.default !== null && !(Array.isArray(p.default) && !p.default.length) ? ` = ${Array.isArray(p.default) ? p.default.join(", ") : String(p.default)}` : ""}`).join("\n");

/** "status: text = active" lines back to property definitions. Bad lines are reported. */
export function parsePropsText(text: string): { props: PropDef[]; bad: string[] } {
  const props: PropDef[] = [], bad: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^([\p{L}\p{N}_][\p{L}\p{N}_.-]*)\s*(?::\s*([a-z]+))?\s*(?:=\s*(.*))?$/u);
    if (!m || (m[2] && !(PROP_TYPES as readonly string[]).includes(m[2]))) { bad.push(line); continue; }
    const type = (m[2] ?? "text") as PropType;
    const d = m[3]?.trim();
    props.push(d ? { key: m[1], type, default: type === "list" ? d.split(",").map((x) => x.trim()).filter(Boolean) : type === "checkbox" ? d === "true" : type === "number" ? Number(d) : d } : { key: m[1], type });
  }
  return { props, bad };
}

export function NoteTypesEditor({ initial, error }: { initial: NoteType[]; error: string | null }) {
  const router = useRouter();
  const [drafts, setDrafts] = useState<Draft[]>(initial.map((t) => ({ id: t.id, name: t.name, props: propsText(t.properties), template: t.template })));
  const [msg, setMsg] = useState<string | null>(error);
  const [pending, start] = useTransition();
  const set = (k: number, patch: Partial<Draft>) => setDrafts((ds) => ds.map((d, i) => (i === k ? { ...d, ...patch } : d)));

  const save = () => {
    const out: Array<Omit<NoteType, "id"> & { id?: string }> = [];
    for (const d of drafts) {
      const { props, bad } = parsePropsText(d.props);
      if (bad.length) { setMsg(`${d.name || "A type"}: can't read “${bad[0]}”. Write key: type = default, with type one of ${PROP_TYPES.join(", ")}.`); return; }
      if (!d.name.trim()) { setMsg("Every type needs a name."); return; }
      out.push({ id: d.id || undefined, name: d.name.trim(), properties: props, template: d.template });
    }
    start(async () => {
      const r = await saveNoteTypesAction(out);
      setMsg(r.ok ? "Saved to .daily-brief/note-types.json" : r.error);
      if (r.ok) { setDrafts(r.types.map((t) => ({ id: t.id, name: t.name, props: propsText(t.properties), template: t.template }))); router.refresh(); }
    });
  };

  const make = (id: string) => start(async () => {
    const r = await createTypedNoteAction(id, "");
    if (r.ok) router.push(`/notes/${encodeURIComponent(r.slug)}`); else setMsg(r.error);
  });

  return (
    <div className="st-types">
      {drafts.map((d, k) => (
        <fieldset key={d.id || `new-${k}`} className="st-type">
          <legend className="st-type__legend">
            <input className="db-input st-type__name" value={d.name} onChange={(e) => set(k, { name: e.target.value })} aria-label="Type name" maxLength={60} placeholder="Type name" />
          </legend>
          <label className="st-type__field">
            <span>Properties <span className="st-hint-inline">one per line: key: type = default ({PROP_TYPES.join(", ")}); {"{{date}}"} is the day it’s made</span></span>
            <textarea className="db-input st-type__props" rows={Math.max(3, d.props.split("\n").length + 1)} value={d.props} onChange={(e) => set(k, { props: e.target.value })} spellCheck={false} />
          </label>
          <label className="st-type__field">
            <span>Template <span className="st-hint-inline">after the “# Title” line; {"{{title}}"} and {"{{date}}"} work</span></span>
            <textarea className="db-input st-type__tpl" rows={Math.max(4, d.template.split("\n").length + 1)} value={d.template} onChange={(e) => set(k, { template: e.target.value })} spellCheck={false} />
          </label>
          <div className="st-type__acts">
            {d.id && initial.some((t) => t.id === d.id) ? <button type="button" className="db-act" disabled={pending} onClick={() => make(d.id)}>New {d.name.toLowerCase()}</button> : null}
            <button type="button" className="db-act db-act--danger" onClick={() => setDrafts((ds) => ds.filter((_x, i) => i !== k))}>Remove type</button>
          </div>
        </fieldset>
      ))}
      <div className="st-types__foot">
        <button type="button" className="db-act" onClick={() => setDrafts((ds) => [...ds, { id: "", name: "", props: "", template: "" }])}>+ Add a type</button>
        <button type="button" className="db-act db-act--primary" disabled={pending} onClick={save}>{pending ? "Saving…" : "Save types"}</button>
        {msg ? <span className="st-view__status" role="status">{msg}</span> : null}
      </div>
    </div>
  );
}
