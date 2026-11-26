"use client";

// Check names: one card per unchecked name. Keys: j/k move, 1-3 same as a suggestion,
// p pick someone, n new person, r rename, i not a person, u undo the last one here.
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import type { NameToCheck } from "@/lib/directory/review";
import { confirmManyAction, confirmPersonAction, ignoreNamesAction, mergeAction, undoPeopleAction, type PeopleResult } from "@/app/people-actions";

export interface KnownPerson { id: string; name: string }

interface Done { entry: NameToCheck; label: string; changeId: string | null }

type Form = { key: string; mode: "new" | "rename" } | null;

function typing(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

export function NameReview({ names, people, lastSeen }: { names: NameToCheck[]; people: KnownPerson[]; lastSeen: Record<string, string> }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  // The page keeps each name where it was, so a checked one can be undone in place.
  const [order, setOrder] = useState<string[]>(() => names.map((n) => n.key));
  const [done, setDone] = useState<Map<string, Done>>(new Map());
  const [sel, setSel] = useState<string | null>(names[0]?.key ?? null);
  const [form, setForm] = useState<Form>(null);
  const [error, setError] = useState<{ key: string; text: string } | null>(null);
  const history = useRef<string[]>([]);

  useEffect(() => {
    setOrder((o) => [...o, ...names.map((n) => n.key).filter((k) => !o.includes(k))]);
  }, [names]);

  const byKey = useMemo(() => new Map(names.map((n) => [n.key, n])), [names]);
  const rows = order
    .map((k) => (done.has(k) ? { key: k, done: done.get(k)!, entry: done.get(k)!.entry } : byKey.has(k) ? { key: k, done: null, entry: byKey.get(k)! } : null))
    .filter((r): r is NonNullable<typeof r> => !!r);
  const open = rows.filter((r) => !r.done);

  const nextAfter = useCallback((key: string) => {
    const i = rows.findIndex((r) => r.key === key);
    return rows.slice(i + 1).find((r) => !r.done)?.key ?? rows.slice(0, i).reverse().find((r) => !r.done)?.key ?? null;
  }, [rows]);

  const act = useCallback((entry: NameToCheck, fn: () => Promise<PeopleResult>) => {
    setError(null);
    start(async () => {
      const r = await fn();
      if (!r.ok) { setError({ key: entry.key, text: r.error }); return; }
      setDone((d) => new Map(d).set(entry.key, { entry, label: r.label, changeId: r.changeId }));
      history.current.push(entry.key);
      setForm(null);
      setSel(nextAfter(entry.key));
      router.refresh();
    });
  }, [nextAfter, router]);

  const undo = useCallback((key: string) => {
    const d = done.get(key);
    if (!d?.changeId) return;
    start(async () => {
      const r = await undoPeopleAction(d.changeId!);
      if (!r.ok) { setError({ key, text: r.error }); return; }
      // One change can cover several names (the bulk confirm): bring them all back.
      const keys = [...done.entries()].filter(([, v]) => v.changeId === d.changeId).map(([k]) => k);
      setDone((m) => { const n = new Map(m); keys.forEach((k) => n.delete(k)); return n; });
      history.current = history.current.filter((k) => !keys.includes(k));
      setSel(key);
      router.refresh();
    });
  }, [done, router]);

  const sameAs = (e: NameToCheck, s: NameToCheck["suggestions"][number]) =>
    act(e, () => mergeAction({ name: e.name, spellings: e.spellings }, s.personId ? { personId: s.personId } : { name: s.name, spellings: s.spellings }));
  const pick = (e: NameToCheck, value: string) => {
    if (value.startsWith("p:")) act(e, () => mergeAction({ name: e.name, spellings: e.spellings }, { personId: value.slice(2) }));
    else if (value.startsWith("n:")) {
      const other = byKey.get(value.slice(2));
      if (other) act(e, () => mergeAction({ name: e.name, spellings: e.spellings }, { name: other.name, spellings: other.spellings }));
    }
  };
  const plain = open.filter((r) => !r.entry.suggestions.length).map((r) => r.entry);
  const confirmPlain = () => {
    setError(null);
    start(async () => {
      const r = await confirmManyAction(plain.map((e) => ({ name: e.name, spellings: e.spellings })));
      if (!r.ok) { setError({ key: plain[0]?.key ?? "", text: r.error }); return; }
      setDone((d) => { const n = new Map(d); for (const e of plain) n.set(e.key, { entry: e, label: `${e.name} confirmed as is`, changeId: r.changeId }); return n; });
      history.current.push(...plain.map((e) => e.key));
      setSel(open.find((x) => x.entry.suggestions.length)?.key ?? null);
      router.refresh();
    });
  };
  const ignore = (e: NameToCheck) => act(e, () => ignoreNamesAction({ spellings: e.spellings }));

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.defaultPrevented || ev.metaKey || ev.ctrlKey || ev.altKey || typing(ev.target)) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      const k = ev.key;
      if (k === "j" || k === "k") {
        ev.preventDefault();
        const i = rows.findIndex((r) => r.key === sel);
        const next = k === "j" ? Math.min(rows.length - 1, i + 1) : Math.max(0, i < 0 ? 0 : i - 1);
        setSel(rows[next]?.key ?? null);
        setForm(null);
        return;
      }
      if (k === "u") {
        const last = history.current[history.current.length - 1];
        const target = sel && done.has(sel) ? sel : last;
        if (target) { ev.preventDefault(); undo(target); }
        return;
      }
      const row = rows.find((r) => r.key === sel);
      if (!row || row.done || pending) return;
      const e = row.entry;
      if (/^[1-3]$/.test(k) && e.suggestions[Number(k) - 1]) { ev.preventDefault(); sameAs(e, e.suggestions[Number(k) - 1]); }
      else if (k === "n") { ev.preventDefault(); setForm({ key: e.key, mode: "new" }); }
      else if (k === "r") { ev.preventDefault(); setForm({ key: e.key, mode: "rename" }); }
      else if (k === "i") { ev.preventDefault(); ignore(e); }
      else if (k === "p") { ev.preventDefault(); document.getElementById(`pick-${e.key}`)?.focus(); }
      else if (k === "Escape") setForm(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    if (sel) document.getElementById(`name-${sel}`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  if (!rows.length) {
    return <p className="nr-empty">Every name is checked. New names from meetings show up here.</p>;
  }

  return (
    <>
      <p className="nr-keys" aria-hidden="true">
        <span><kbd className="db-kbd">j</kbd><kbd className="db-kbd">k</kbd> move</span>
        <span><kbd className="db-kbd">1</kbd>–<kbd className="db-kbd">3</kbd> same as</span>
        <span><kbd className="db-kbd">p</kbd> pick someone</span>
        <span><kbd className="db-kbd">n</kbd> new person</span>
        <span><kbd className="db-kbd">r</kbd> rename</span>
        <span><kbd className="db-kbd">i</kbd> not a person</span>
        <span><kbd className="db-kbd">u</kbd> undo</span>
      </p>
      <div className="nr-countbar">
        <p className="nr-count" role="status">{open.length ? `${open.length} left to check` : "All checked. Nice."}</p>
        {plain.length > 1 ? (
          <button type="button" className="db-btn nr-small" disabled={pending} onClick={confirmPlain} title={plain.map((e) => e.name).join(", ")}>
            Confirm {plain.length} names with no look-alikes as they are
          </button>
        ) : null}
      </div>
      <ol className="nr-list">
        {rows.map(({ key, entry: e, done: d }) => (
          <li
            key={key}
            id={`name-${key}`}
            className={`nr-card${sel === key ? " nr-card--sel" : ""}${d ? " nr-card--done" : ""}`}
            onClick={() => setSel(key)}
          >
            {d ? (
              <div className="nr-done">
                <span className="nr-done__mark" aria-hidden="true">✓</span>
                <span className="nr-done__label">{d.label}</span>
                {d.changeId ? <button type="button" className="db-btn db-btn--ghost nr-small" onClick={(ev) => { ev.stopPropagation(); undo(key); }} disabled={pending}>Undo</button> : null}
              </div>
            ) : (
              <>
                <div className="nr-head">
                  <h2 className="nr-name">{e.name}</h2>
                  {e.spellings.length > 1 ? <span className="nr-aka">also {e.spellings.filter((s) => s !== e.name).join(", ")}</span> : null}
                  <span className="nr-facts">
                    {e.items} {e.items === 1 ? "item" : "items"} · {e.meetings} {e.meetings === 1 ? "meeting" : "meetings"}
                    {lastSeen[key] ? ` · last ${lastSeen[key]}` : ""}
                  </span>
                </div>
                {e.quote ? (
                  <blockquote className="nr-quote">
                    “{e.quote.text}”{e.quote.meeting ? <cite> {e.quote.meeting}</cite> : null}
                  </blockquote>
                ) : null}
                <div className="nr-acts">
                  {e.suggestions.map((s, k) => (
                    <button key={s.name} type="button" className="db-btn nr-sugg" disabled={pending} onClick={() => sameAs(e, s)} title={s.why.join(", ")}>
                      <kbd className="db-kbd" aria-hidden="true">{k + 1}</kbd>
                      <span>Same as <b>{s.name}</b></span>
                      {s.why.length ? <span className="nr-why">{s.why.join(" · ")}</span> : null}
                      {!s.personId ? <span className="nr-why">unchecked</span> : null}
                    </button>
                  ))}
                  <label className="nr-pick">
                    <span className="nr-sr">Same as someone else</span>
                    <select id={`pick-${key}`} className="db-input nr-select" value="" disabled={pending} onChange={(ev) => pick(e, ev.target.value)}>
                      <option value="">{e.suggestions.length ? "Someone else…" : "Same as…"}</option>
                      {people.length ? <optgroup label="People">{people.map((p) => <option key={p.id} value={`p:${p.id}`}>{p.name}</option>)}</optgroup> : null}
                      {names.length > 1 ? <optgroup label="Not checked yet">{names.filter((n) => n.key !== key).map((n) => <option key={n.key} value={`n:${n.key}`}>{n.name}</option>)}</optgroup> : null}
                    </select>
                  </label>
                </div>
                <div className="nr-acts nr-acts--2">
                  <button type="button" className="db-btn db-btn--ghost nr-small" disabled={pending} onClick={() => setForm({ key, mode: "new" })}><kbd className="db-kbd" aria-hidden="true">n</kbd>New person</button>
                  <button type="button" className="db-btn db-btn--ghost nr-small" disabled={pending} onClick={() => setForm({ key, mode: "rename" })}><kbd className="db-kbd" aria-hidden="true">r</kbd>Rename</button>
                  <button type="button" className="db-btn db-btn--ghost nr-small" disabled={pending} onClick={() => ignore(e)}><kbd className="db-kbd" aria-hidden="true">i</kbd>Not a person</button>
                </div>
                {form?.key === key ? (
                  <PersonForm
                    mode={form.mode}
                    entry={e}
                    pending={pending}
                    onCancel={() => setForm(null)}
                    onSave={(name, email) => act(e, () => confirmPersonAction({ name, spellings: e.spellings, email }))}
                  />
                ) : null}
                {error?.key === key ? <p className="db-note db-note--error" role="alert">{error.text}</p> : null}
              </>
            )}
          </li>
        ))}
      </ol>
    </>
  );
}

function PersonForm({ mode, entry, pending, onSave, onCancel }: { mode: "new" | "rename"; entry: NameToCheck; pending: boolean; onSave: (name: string, email: string) => void; onCancel: () => void }) {
  const [name, setName] = useState(entry.name);
  const [email, setEmail] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (mode === "rename") { nameRef.current?.focus(); nameRef.current?.select(); }
    else emailRef.current?.focus();
  }, [mode]);
  return (
    <form
      className="nr-form"
      onSubmit={(ev) => { ev.preventDefault(); onSave(name, email); }}
      onKeyDown={(ev) => { if (ev.key === "Escape") { ev.preventDefault(); onCancel(); } }}
    >
      <label className="nr-form__field">
        <span>{mode === "rename" ? "Right spelling" : "Name"}</span>
        <input ref={nameRef} className="db-input" value={name} onChange={(ev) => setName(ev.target.value)} maxLength={80} required />
      </label>
      <label className="nr-form__field">
        <span>Email <i>optional</i></span>
        <input ref={emailRef} className="db-input" type="email" value={email} onChange={(ev) => setEmail(ev.target.value)} maxLength={200} placeholder="name@company.com" />
      </label>
      <div className="nr-form__acts">
        <button type="submit" className="db-btn db-btn--primary nr-small" disabled={pending}>{mode === "rename" ? "Save spelling" : "Add person"}</button>
        <button type="button" className="db-btn db-btn--ghost nr-small" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
