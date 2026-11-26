"use client";

// The Projects page's buttons: make a project from a topic your meetings share, and file again.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createProjectFromTopicAction, refileProjectsAction, removeProjectAction } from "@/app/structure-actions";

export function SuggestedProjects({ topics }: { topics: Array<{ key: string; label: string; meetings: number; items: number }> }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [made, setMade] = useState<Record<string, { slug: string; filed: number; created: boolean }>>({});
  const [undone, setUndone] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const make = (key: string) => start(async () => {
    setError(null);
    const r = await createProjectFromTopicAction(topics.find((t) => t.key === key)?.label ?? key);
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
          <li key={t.key} className="st-list__row pf-suggest">
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
              <button type="button" className="db-act" disabled={pending} onClick={() => make(t.key)}>Make project</button>
            )}
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
