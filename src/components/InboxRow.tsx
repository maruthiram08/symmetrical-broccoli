"use client";

// One Inbox item: pick You owe or Waiting on, add a person and a date, then put it on its list,
// or delete it. Nothing changes until you press a button.
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { deleteInboxAction, triageAction } from "@/app/inbox-actions";

export interface InboxEntry { id: string; text: string; note: string | null; added: string; kind: "owe" | "waiting" }

export function InboxRow({ item, people }: { item: InboxEntry; people: string[] }) {
  const router = useRouter();
  const ids = useId();
  const [kind, setKind] = useState<"owe" | "waiting">(item.kind);
  const [person, setPerson] = useState("");
  const [due, setDue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const run = (fn: () => Promise<{ ok: true } | { ok: false; error: string }>) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) setError(r.error);
      else router.refresh();
    });

  return (
    <li className="ib-row" aria-busy={pending || undefined}>
      <div className="ib-row__head">
        <span className="ib-row__text">{item.text}</span>
        <span className="ib-row__added db-mono">{item.added}</span>
      </div>
      {item.note ? <p className="ib-row__note">{item.note}</p> : null}
      <div className="ib-row__fields">
        <div className="db-capture__seg" role="group" aria-label="Kind">
          <button type="button" aria-pressed={kind === "owe"} onClick={() => setKind("owe")}>You owe</button>
          <button type="button" aria-pressed={kind === "waiting"} onClick={() => setKind("waiting")}>Waiting on</button>
        </div>
        <input className="db-input ib-row__person" list={`${ids}-people`} value={person} onChange={(e) => setPerson(e.target.value)} placeholder="Person" aria-label="Person" maxLength={80} />
        <datalist id={`${ids}-people`}>{people.map((p) => <option key={p} value={p} />)}</datalist>
        <input className="db-input ib-row__due" type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due" />
      </div>
      <div className="ib-row__acts">
        <button type="button" className="db-act db-act--primary" disabled={pending}
          onClick={() => run(() => triageAction(item.id, { kind, person: person.trim() || null, dueDate: due || null }))}>
          {kind === "owe" ? "Move to You owe" : "Move to Waiting on"}
        </button>
        <button type="button" className="db-act db-act--danger" disabled={pending} onClick={() => run(() => deleteInboxAction(item.id))}>Delete</button>
      </div>
      {error ? <p className="db-capture__error" role="alert">{error}</p> : null}
    </li>
  );
}
