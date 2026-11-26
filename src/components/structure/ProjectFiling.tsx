"use client";

// The Projects page's buttons: make a project from a topic your meetings share, and file again.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createProjectFromTopicAction, refileProjectsAction } from "@/app/structure-actions";

export function SuggestedProjects({ topics }: { topics: Array<{ key: string; label: string; meetings: number; items: number }> }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [made, setMade] = useState<Record<string, { slug: string; filed: number }>>({});
  const [error, setError] = useState<string | null>(null);
  const make = (key: string) => start(async () => {
    setError(null);
    const r = await createProjectFromTopicAction(topics.find((t) => t.key === key)?.label ?? key);
    if (!r.ok) { setError(r.error); return; }
    setMade((m) => ({ ...m, [key]: { slug: r.slug, filed: r.filed } }));
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
              <Link className="db-link" href={`/notes/${encodeURIComponent(made[t.key].slug)}`}>Made · {made[t.key].filed} filed</Link>
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
