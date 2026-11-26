"use client";

// A person page for a name nobody has yet (a [[person:X]] link in a note): add them as a new
// person, or say they are someone you already know. Uses the people directory actions.
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { confirmPersonAction, mergeAction } from "@/app/people-actions";
import type { NameRef } from "@/lib/directory/directory";
import { personSlug } from "@/lib/people";

export function UnknownPerson({ name, speaker, targets }: { name: string; speaker: boolean; targets: Array<{ value: string; label: string; slug: string; ref: NameRef }> }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [spelling, setSpelling] = useState(name);
  const [pick, setPick] = useState("");
  const [error, setError] = useState<string | null>(null);
  const go = (slug: string, changeId: string | null) => router.push(`/people/${encodeURIComponent(slug)}${changeId ? `?merged=${encodeURIComponent(changeId)}` : ""}`);

  return (
    <div className="nr-unknown">
      <p className="nr-unknown__lead">
        {speaker
          ? `No one called ${name} yet. It looks like a transcription speaker label, not a person.`
          : `No one called ${name} yet.`}
      </p>
      <form className="nr-manage__row" onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        start(async () => {
          const r = await confirmPersonAction({ name: spelling, spellings: [spelling] });
          if (!r.ok) { setError(r.error); return; }
          go(personSlug(spelling), r.changeId);
        });
      }}>
        <label className="nr-sr" htmlFor="unknown-name">Name</label>
        <input id="unknown-name" className="db-input nr-newname" value={spelling} maxLength={80} onChange={(e) => setSpelling(e.target.value)} />
        <button className="db-btn db-btn--primary nr-small" type="submit" disabled={pending || !spelling.trim()}>Add as a new person</button>
      </form>
      {targets.length ? (
        <form className="nr-manage__row" onSubmit={(e) => {
          e.preventDefault();
          const t = targets.find((x) => x.value === pick);
          if (!t) return;
          setError(null);
          start(async () => {
            const r = await mergeAction({ name: spelling, spellings: [spelling] }, t.ref);
            if (!r.ok) { setError(r.error); return; }
            go(t.slug, r.changeId);
          });
        }}>
          <label className="nr-manage__label" htmlFor="unknown-pick">Or it’s someone you know</label>
          <select id="unknown-pick" className="db-input nr-select" value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">Pick someone…</option>
            {targets.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
          <button className="db-btn nr-small" type="submit" disabled={pending || !pick}>Same person</button>
        </form>
      ) : null}
      {error ? <p className="db-note db-note--error" role="alert">{error}</p> : null}
    </div>
  );
}
