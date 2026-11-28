"use client";

// On a person's page: fix who they are. Merge into someone else, split items off to another
// person, or (for a confirmed person) edit the name, email and note. Each change has Undo.
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { editPersonAction, mergeAction, moveItemsAction, undoPeopleAction, type PeopleResult } from "@/app/people-actions";
import type { NameRef } from "@/lib/directory/directory";

export interface ManageTarget { value: string; label: string; slug: string; ref: NameRef }
export interface ManageItem { id: string; text: string; kind: string; status: string }

export function PersonManage({
  self, name, personId, email, note, items, targets, undo,
}: {
  /** A change just made elsewhere (a merge that brought you here), offered for Undo. */
  undo?: { changeId: string; label: string } | null;
  /** This person as a source: a directory person, or an unchecked name with its spellings. */
  self: NameRef;
  name: string;
  personId?: string;
  email?: string | null;
  note?: string | null;
  items: ManageItem[];
  targets: ManageTarget[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ text: string; changeId: string | null } | null>(undo ? { text: undo.label, changeId: undo.changeId } : null);
  const [error, setError] = useState<string | null>(null);
  const [into, setInto] = useState("");
  const [splitTo, setSplitTo] = useState("");
  const [newName, setNewName] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [details, setDetails] = useState({ name, email: email ?? "", note: note ?? "" });

  const run = (fn: () => Promise<PeopleResult>, after?: string) => start(async () => {
    setError(null);
    const r = await fn();
    if (!r.ok) { setError(r.error); return; }
    setPicked(new Set());
    if (after) { router.push(`${after}${r.changeId ? `?merged=${encodeURIComponent(r.changeId)}` : ""}`); return; }
    setMsg({ text: r.label, changeId: r.changeId });
    router.refresh();
  });
  const targetRef = (v: string) => targets.find((t) => t.value === v)?.ref;

  return (
    <section className="db-section nr-manage" aria-label="Merge or split">
      <details>
        <summary className="nr-manage__sum">Not the right person? Merge or split</summary>
        <div className="nr-manage__body">
          <form className="nr-manage__row" onSubmit={(e) => {
            e.preventDefault();
            const ref = targetRef(into);
            if (ref) run(() => mergeAction(self, ref), `/people/${encodeURIComponent(targets.find((t) => t.value === into)!.slug)}`);
          }}>
            <label className="nr-manage__label" htmlFor="merge-into">Merge {name} into</label>
            <select id="merge-into" className="db-input nr-select" value={into} onChange={(e) => setInto(e.target.value)}>
              <option value="">Pick someone…</option>
              {targets.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
            <button className="db-btn nr-small" type="submit" disabled={!into || pending}>Merge</button>
          </form>

          {items.length ? (
            <form className="nr-split" onSubmit={(e) => {
              e.preventDefault();
              const ref: NameRef | undefined = splitTo === "new" ? (newName.trim() ? { name: newName.trim() } : undefined) : targetRef(splitTo);
              if (ref) run(() => moveItemsAction([...picked], ref));
            }}>
              <p className="nr-manage__label">Split: move items that are really someone else’s</p>
              <ul className="nr-split__list">
                {items.map((i) => (
                  <li key={i.id}>
                    <label className="nr-split__item">
                      <input type="checkbox" checked={picked.has(i.id)} onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(i.id); else n.delete(i.id); return n; })} />
                      <span className="nr-split__text">{i.text}</span>
                      <span className="nr-split__kind">{i.kind === "owe" ? "You owe" : i.kind === "waiting" ? "Waiting on" : "Decision"}{i.status !== "open" ? ` · ${i.status}` : ""}</span>
                    </label>
                  </li>
                ))}
              </ul>
              <div className="nr-manage__row">
                <label className="nr-manage__label" htmlFor="split-to">Move {picked.size || ""} to</label>
                <select id="split-to" className="db-input nr-select" value={splitTo} onChange={(e) => setSplitTo(e.target.value)}>
                  <option value="">Pick someone…</option>
                  <option value="new">A new person…</option>
                  {targets.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
                {splitTo === "new" ? <input className="db-input nr-newname" aria-label="New person's name" placeholder="Their name" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={80} /> : null}
                <button className="db-btn nr-small" type="submit" disabled={!picked.size || !splitTo || (splitTo === "new" && !newName.trim()) || pending}>Move</button>
              </div>
            </form>
          ) : null}

          {personId ? (
            <form className="nr-details" onSubmit={(e) => { e.preventDefault(); run(() => editPersonAction(personId, details)); }}>
              <p className="nr-manage__label">Details</p>
              <div className="nr-details__grid">
                <label><span>Name</span><input className="db-input" value={details.name} maxLength={80} onChange={(e) => setDetails({ ...details, name: e.target.value })} /></label>
                <label><span>Email</span><input className="db-input" type="email" value={details.email} maxLength={200} onChange={(e) => setDetails({ ...details, email: e.target.value })} placeholder="optional" /></label>
                <label className="nr-details__note"><span>Note</span><input className="db-input" value={details.note} maxLength={1000} onChange={(e) => setDetails({ ...details, note: e.target.value })} placeholder="Role, team, how to reach them" /></label>
              </div>
              <button className="db-btn nr-small" type="submit" disabled={pending}>Save details</button>
            </form>
          ) : null}
        </div>
      </details>
      {msg ? (
        <p className="nr-toast" role="status">
          {msg.text}
          {msg.changeId ? <button type="button" className="db-btn db-btn--ghost nr-small" disabled={pending} onClick={() => start(async () => { const r = await undoPeopleAction(msg.changeId!); setMsg(r.ok ? { text: r.label, changeId: null } : null); router.refresh(); })}>Undo</button> : null}
        </p>
      ) : null}
      {error ? <p className="db-note db-note--error" role="alert">{error}</p> : null}
    </section>
  );
}
