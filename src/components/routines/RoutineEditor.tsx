"use client";

// Add or edit a routine: what, how often, an optional time and person. The same fields edit a
// suggestion from a meeting before adding it. Laid out like quick capture's details.
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { addRoutineAction, addSuggestionAction, archiveRoutineAction, deleteRoutineAction, updateRoutineAction } from "@/app/routine-actions";
import { cadenceLabel, DAY_NAMES } from "@/lib/routines/words";
import type { Cadence, Weekday } from "@/lib/routines/types";

type Kind = Cadence["kind"];
const KINDS: Array<[Kind, string]> = [["daily", "Every day"], ["weekdays", "Weekdays"], ["weekly", "Weekly"], ["monthly", "Monthly"], ["every", "Every N days"]];
/** Monday first. */
const WEEK: Weekday[] = [1, 2, 3, 4, 5, 6, 0];

export interface EditorValue { title: string; cadence: Cadence; time: string | null; person: string | null; archived?: boolean }

export function RoutineEditor({ mode, id, initial, today, people, onDone }: {
  mode: "add" | "edit" | "suggestion";
  /** The routine (edit) or suggestion (suggestion) id. */
  id?: string;
  initial?: EditorValue;
  /** Your today, YYYY-MM-DD: what weekly and monthly start from. */
  today: string;
  people: string[];
  onDone?: () => void;
}) {
  const router = useRouter();
  const ids = useId();
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay() as Weekday;
  const c = initial?.cadence;
  const [title, setTitle] = useState(initial?.title ?? "");
  const [kind, setKind] = useState<Kind>(c?.kind ?? "weekly");
  const [days, setDays] = useState<Weekday[]>(c?.kind === "weekly" ? c.days : [dow]);
  const [day, setDay] = useState(c?.kind === "monthly" ? c.day : Number(today.slice(8, 10)));
  const [n, setN] = useState(c?.kind === "every" ? c.n : 2);
  const from = c?.kind === "every" ? c.from : today;
  const [time, setTime] = useState(initial?.time ?? "");
  const [person, setPerson] = useState(initial?.person ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const cadence: Cadence = kind === "weekly" ? { kind, days } : kind === "monthly" ? { kind, day } : kind === "every" ? { kind, n, from } : { kind };
  const toggle = (d: Weekday) => setDays((xs) => (xs.includes(d) ? xs.filter((x) => x !== d) : [...xs, d]));

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) => start(async () => {
    const r = await fn();
    if (!r.ok) { setError(r.error ?? "Couldn't save."); return; }
    setError(null);
    if (mode === "add") { setTitle(""); setTime(""); setPerson(""); }
    onDone?.();
    router.refresh();
  });
  const save = () => {
    if (pending) return;
    const input = { title, cadence, time: time || null, person: person.trim() || null };
    run(() => (mode === "edit" && id ? updateRoutineAction(id, input) : mode === "suggestion" && id ? addSuggestionAction(id, input) : addRoutineAction(input)));
  };

  return (
    <form className="rt-editor" onSubmit={(e) => { e.preventDefault(); save(); }} aria-label={mode === "edit" ? "Edit routine" : "New routine"}>
      <div className="rt-editor__line">
        <span className="db-mark rt-mark" aria-hidden="true" />
        <input className="rt-editor__title" value={title} onChange={(e) => { setTitle(e.target.value); setError(null); }} placeholder="Send the sprint report to Tarun" aria-label="What you do" maxLength={200} autoFocus={mode !== "add"} />
      </div>
      <div className="rt-editor__row">
        <div className="db-capture__seg rt-seg" role="group" aria-label="How often">
          {KINDS.map(([k, label]) => <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>{label}</button>)}
        </div>
      </div>
      {kind === "weekly" ? (
        <div className="rt-editor__row rt-days" role="group" aria-label="On these days">
          {WEEK.map((d) => <button key={d} type="button" className="rt-day" aria-pressed={days.includes(d)} aria-label={DAY_NAMES[d]} onClick={() => toggle(d)}>{DAY_NAMES[d].slice(0, 2)}</button>)}
        </div>
      ) : null}
      <div className="db-capture__fields rt-editor__fields">
        {kind === "monthly" ? (
          <label className="db-capture__field">
            <span>Day of the month</span>
            <input className="db-input" type="number" min={1} max={31} value={day} onChange={(e) => setDay(Number(e.target.value))} />
          </label>
        ) : null}
        {kind === "every" ? (
          <label className="db-capture__field">
            <span>Every how many days</span>
            <input className="db-input" type="number" min={2} max={365} value={n} onChange={(e) => setN(Number(e.target.value))} />
          </label>
        ) : null}
        <label className="db-capture__field">
          <span>Time (optional)</span>
          <input className="db-input" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </label>
        <label className="db-capture__field">
          <span>For (optional)</span>
          <input className="db-input" list={`${ids}-people`} value={person} onChange={(e) => setPerson(e.target.value)} placeholder="No one" maxLength={80} />
          <datalist id={`${ids}-people`}>{people.map((p) => <option key={p} value={p} />)}</datalist>
        </label>
      </div>
      {error ? <p className="db-capture__error" role="alert">{error}</p> : null}
      <div className="rt-editor__foot">
        <span className="rt-editor__read db-mono">{cadenceLabel(cadence, time || null)}{kind === "monthly" && day > 28 ? " (or the month's last day)" : ""}</span>
        <span className="rt-editor__end">
          {mode === "edit" && id ? (
            <>
              <button type="button" className="db-act" disabled={pending} onClick={() => run(() => archiveRoutineAction(id, !initial?.archived))}>{initial?.archived ? "Unarchive" : "Archive"}</button>
              <button type="button" className="db-act db-act--danger" disabled={pending} onClick={() => { if (window.confirm("Delete this routine and its history?")) run(() => deleteRoutineAction(id)); }}>Delete</button>
            </>
          ) : null}
          {onDone && mode !== "add" ? <button type="button" className="db-act" onClick={onDone}>Cancel</button> : null}
          <button type="submit" className="db-act db-act--primary" disabled={pending || !title.trim()}>
            {pending ? "Saving…" : mode === "edit" ? "Save" : "Add routine"}
          </button>
        </span>
      </div>
    </form>
  );
}
