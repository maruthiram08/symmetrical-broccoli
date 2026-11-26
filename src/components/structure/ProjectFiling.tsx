"use client";

// The Projects page's buttons: make a project from a topic your meetings share (after a preview
// of what it would take), and file again.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createProjectFromTopicAction, previewProjectAction, refileProjectsAction, removeProjectAction } from "@/app/structure-actions";
import type { ProjectPreview } from "@/server/structure/autofile";

export function SuggestedProjects({ topics }: { topics: Array<{ key: string; label: string; meetings: number; items: number }> }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [made, setMade] = useState<Record<string, { slug: string; filed: number; created: boolean }>>({});
  const [undone, setUndone] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ key: string; p: ProjectPreview } | null>(null);
  const label = (key: string) => topics.find((t) => t.key === key)?.label ?? key;
  // "Make project" first shows what it would take; you make it from there, or don't.
  const look = (key: string) => start(async () => {
    setError(null);
    const r = await previewProjectAction(label(key));
    if (!r.ok) { setError(r.error); return; }
    setPreview({ key, p: { items: r.items, total: r.total, moved: r.moved } });
  });
  const make = (key: string) => start(async () => {
    setError(null);
    setPreview(null);
    const r = await createProjectFromTopicAction(label(key));
    if (!r.ok) { setError(r.error); return; }
    setMade((m) => ({ ...m, [key]: { slug: r.slug, filed: r.filed, created: r.created } }));
    router.refresh();
  });
  // Undo: take back what it filed, and delete the note when this click made it.
  const undo = (key: string) => start(async () => {
    setError(null);
    const m = made[key];
    if (!m) return;
    const r = await removeProjectAction(m.slug, { undo: m.created });
    if (!r.ok) { setError(r.error); return; }
    setMade((all) => Object.fromEntries(Object.entries(all).filter(([k]) => k !== key)));
    setUndone((u) => ({ ...u, [key]: r.cleared }));
    router.refresh();
  });
  return (
    <>
      <ul className="st-list">
        {topics.map((t) => (
          <li key={t.key} className="pf-suggest-wrap">
          <div className="st-list__row pf-suggest">
            <span>{t.label}</span>
            <span className="st-list__meta">{t.meetings} meetings · {t.items} items</span>
            {made[t.key] ? (
              <span className="pf-made">
                <Link className="db-link" href={`/notes/${encodeURIComponent(made[t.key].slug)}`}>Made · {made[t.key].filed} filed</Link>
                <button type="button" className="db-act" disabled={pending} onClick={() => undo(t.key)}>Undo</button>
              </span>
            ) : undone[t.key] !== undefined ? (
              <span className="st-list__meta">Undone · {undone[t.key]} back in Needs a project</span>
            ) : (
              preview?.key === t.key ? null : <button type="button" className="db-act" disabled={pending} onClick={() => look(t.key)}>Make project…</button>
            )}
          </div>
          {preview?.key === t.key ? (
            <div className="pf-preview" role="region" aria-label={`What ${t.label} would take`}>
              <p className="st-list__meta">
                {preview.p.total
                  ? <>It would take {preview.p.total} item{preview.p.total === 1 ? "" : "s"}{preview.p.moved ? `, ${preview.p.moved} of them out of another project` : ""}.{preview.p.items.length ? ` ${preview.p.items.length < preview.p.total ? `The newest ${preview.p.items.length} still open` : "Here they are"}:` : " None of them are still open."}</>
                  : <>Nothing would be filed into it yet. Add keywords to its note after making it.</>}
              </p>
              {preview.p.items.length ? (
                <ul className="pf-preview__list">
                  {preview.p.items.map((i) => <li key={i.id}><span>{i.text}</span>{i.why ? <span className="st-list__meta"> · {i.why}{i.from ? `, now in ${i.from}` : ""}</span> : null}</li>)}
                </ul>
              ) : null}
              <p className="pf-preview__acts">
                <button type="button" className="db-act" disabled={pending} onClick={() => make(t.key)}>{preview.p.total ? `Make it and file ${preview.p.total}` : "Make it"}</button>
                <button type="button" className="db-act" disabled={pending} onClick={() => setPreview(null)}>Cancel</button>
              </p>
            </div>
          ) : null}
          </li>
        ))}
      </ul>
      {error ? <p className="db-snooze__error" role="alert">{error}</p> : null}
    </>
  );
}

export function RefileButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  return (
    <>
      <button type="button" className="db-act" disabled={pending} onClick={() => start(async () => {
        const r = await refileProjectsAction();
        setNote(r.ok ? `${r.filed} filed, ${r.unfiled} open need a project.` : r.error);
        router.refresh();
      })}>{pending ? "Filing…" : "File again"}</button>
      {note ? <span className="st-list__meta" role="status"> {note}</span> : null}
    </>
  );
}
