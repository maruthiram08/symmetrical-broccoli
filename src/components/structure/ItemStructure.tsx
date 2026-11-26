"use client";

// On an item's page: its project and tags, both editable.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { setItemProjectAction, setItemTagsAction } from "@/app/structure-actions";
import { tagHref } from "@/lib/structure/tag-core";

const NEW = "__new";

export function ItemStructure({ itemId, project, tags, projects, known }: { itemId: string; project: string | null; tags: string[]; projects: Array<{ slug: string; title: string }>; known: string[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState(tags.map((t) => `#${t}`).join(" "));
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setError(null);
    start(async () => {
      const r = await fn().catch(() => ({ ok: false, error: "Couldn't reach Daily brief." }));
      if (!r.ok) { setError(r.error ?? "Couldn't save."); return; }
      router.refresh();
    });
  };
  const saveTags = () => { if (draft.trim() !== tags.map((t) => `#${t}`).join(" ")) run(() => setItemTagsAction(itemId, draft) as Promise<{ ok: boolean; error?: string }>); };

  return (
    <div className="st-itemmeta" aria-label="Project and tags">
      <label className="st-itemmeta__row">
        <span className="st-itemmeta__key">Project</span>
        {creating ? (
          <form className="st-itemmeta__new" onSubmit={(e) => { e.preventDefault(); if (name.trim()) { run(() => setItemProjectAction(itemId, name, { create: true }) as Promise<{ ok: boolean; error?: string }>); setCreating(false); } }}>
            <input className="db-input st-itemmeta__input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="New project name" maxLength={80} onKeyDown={(e) => { if (e.key === "Escape") setCreating(false); }} />
            <button className="db-act db-act--primary" type="submit" disabled={!name.trim() || pending}>Make</button>
          </form>
        ) : (
          <select className="db-input st-itemmeta__input" value={project ?? ""} disabled={pending} onChange={(e) => {
            if (e.target.value === NEW) { setCreating(true); return; }
            const v = e.target.value;
            run(() => setItemProjectAction(itemId, v) as Promise<{ ok: boolean; error?: string }>);
          }}>
            <option value="">No project</option>
            {projects.map((p) => <option key={p.slug} value={p.slug}>{p.title}</option>)}
            {project && !projects.some((p) => p.slug === project) ? <option value={project}>{project}</option> : null}
            <option value={NEW}>New project…</option>
          </select>
        )}
        {project ? <Link className="db-link" href={`/notes/${encodeURIComponent(project)}`}>Open</Link> : null}
      </label>
      <label className="st-itemmeta__row">
        <span className="st-itemmeta__key">Tags</span>
        <input className="db-input st-itemmeta__input" list="st-known-tags" value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={saveTags} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveTags(); } }} placeholder="#launch #ops/infra" maxLength={400} disabled={pending} />
        <datalist id="st-known-tags">{known.map((t) => <option key={t} value={`#${t}`} />)}</datalist>
      </label>
      {tags.length ? <p className="st-itemmeta__tags">{tags.map((t) => <Link key={t} className="st-tag" href={tagHref(t)}>#{t}</Link>)}</p> : null}
      {error ? <p className="st-error" role="alert">{error}</p> : null}
    </div>
  );
}
