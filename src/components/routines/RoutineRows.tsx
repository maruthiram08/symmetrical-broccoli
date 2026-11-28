"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { addSuggestionAction, dismissSuggestionAction } from "@/app/routine-actions";
import { RoutineEditor, type EditorValue } from "./RoutineEditor";
import { TitleWithPerson } from "./Who";

/** One routine on /routines, already worded on the server. Edit opens the editor in place. */
export interface RoutineRowView extends EditorValue {
  id: string;
  label: string;
  next: string | null;
  /** "Overdue since Tue", or null. */
  overdue: string | null;
  lastDone: string | null;
  streak: number;
  fromMeeting: { id: string; title: string } | null;
}

export function RoutineRow({ r, today, people }: { r: RoutineRowView; today: string; people: string[] }) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return <div className="rt-row rt-row--editing"><RoutineEditor mode="edit" id={r.id} initial={r} today={today} people={people} onDone={() => setEditing(false)} /></div>;
  }
  return (
    <div className={`db-item rt-row${r.archived ? " rt-row--archived" : ""}`}>
      <span className="db-item__icon"><span className="db-mark rt-mark" aria-hidden="true" /></span>
      <span className="db-item__text"><TitleWithPerson title={r.title} person={r.person} /></span>
      <span className="db-item__side">
        {r.archived ? <span className="db-item__time">Archived</span>
          : r.overdue ? <span className="db-item__late">{r.overdue}</span>
          : r.next ? <span className="db-item__time">{r.next === "Today" ? "Due today" : r.next === "Tomorrow" ? "Tomorrow" : `Next ${r.next}`}</span> : null}
      </span>
      <span className="db-item__meta">
        <span>{r.label}</span>
        <span className="db-item__src">· {r.lastDone ? `Last done ${r.lastDone}` : "Not done yet"}</span>
        {r.streak >= 2 ? <span className="db-item__src rt-streak">· {r.streak} in a row</span> : null}
        {r.fromMeeting ? <Link className="db-item__src" href={`/meeting/${r.fromMeeting.id}`}>· From {r.fromMeeting.title}</Link> : null}
      </span>
      <span className="db-item__acts">
        <button type="button" className="db-act db-act-keep" onClick={() => setEditing(true)}>Edit</button>
      </span>
    </div>
  );
}

export function NewRoutine({ today, people, startOpen }: { today: string; people: string[]; startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen);
  if (!open) return <button type="button" className="db-act db-act--primary rt-new" onClick={() => setOpen(true)}>New routine</button>;
  return <div className="rt-new-box"><RoutineEditor mode="add" today={today} people={people} onDone={startOpen ? undefined : () => setOpen(false)} /></div>;
}

export interface SuggestionView extends EditorValue {
  id: string;
  label: string;
  quote: string;
  meeting: { id: string; title: string; when: string } | null;
}

/** A recurring promise found in a meeting: Add makes it a routine, Dismiss forgets it. */
export function SuggestionCard({ s, today, people }: { s: SuggestionView; today: string; people: string[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const act = (fn: () => Promise<{ ok: boolean; error?: string }>) => start(async () => {
    const r = await fn();
    if (!r.ok) { setError(r.error ?? "Couldn't save."); return; }
    router.refresh();
  });
  if (editing) return <div className="rt-suggest rt-row--editing"><RoutineEditor mode="suggestion" id={s.id} initial={s} today={today} people={people} onDone={() => setEditing(false)} /></div>;
  return (
    <div className="rt-suggest">
      <div className="rt-suggest__head">
        <span className="rt-suggest__title"><TitleWithPerson title={s.title} person={s.person} /></span>
        <span className="rt-suggest__when db-mono">{s.label}</span>
      </div>
      <p className="rt-suggest__quote">&ldquo;{s.quote}&rdquo;{s.meeting ? <> · <Link className="db-link" href={`/meeting/${s.meeting.id}`}>{s.meeting.title}</Link>, {s.meeting.when}</> : null}</p>
      {error ? <p className="db-capture__error" role="alert">{error}</p> : null}
      <div className="rt-suggest__acts">
        <button type="button" className="db-act db-act--primary" disabled={pending} onClick={() => act(() => addSuggestionAction(s.id))}>Add</button>
        <button type="button" className="db-act" disabled={pending} onClick={() => setEditing(true)}>Edit first</button>
        <button type="button" className="db-act" disabled={pending} onClick={() => act(() => dismissSuggestionAction(s.id))}>Dismiss</button>
      </div>
    </div>
  );
}
