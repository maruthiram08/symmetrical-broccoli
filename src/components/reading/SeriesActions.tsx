"use client";

// Recurring: Rename (key R) turns the title into a field in place; "Not a series" moves it to the
// bottom of the list, where "It is a series" puts it back.
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { hideSeriesAction, renameSeriesAction } from "@/app/series-actions";

const typing = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  return e.metaKey || e.ctrlKey || e.altKey || !!t?.closest("input, textarea, select, [contenteditable='true']");
};

export function SeriesActions({ seriesKey, name, guess, hidden }: { seriesKey: string; name: string; guess: string; hidden: boolean }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { setValue(name); setEditing(false); setErr(null); }, [seriesKey, name]);
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (!typing(e) && e.key.toLowerCase() === "r" && !editing) { e.preventDefault(); setEditing(true); } };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [editing]);
  useEffect(() => { if (editing) { input.current?.focus(); input.current?.select(); } }, [editing]);

  const save = async (next: string) => {
    setBusy(true); setErr(null);
    const r = await renameSeriesAction(seriesKey, next);
    setBusy(false);
    if (!r.ok) { setErr(r.error); return; }
    setEditing(false);
    router.refresh();
  };
  const hide = async (on: boolean) => {
    setBusy(true);
    const r = await hideSeriesAction(seriesKey, on);
    setBusy(false);
    if (!r.ok) { setErr(r.error); return; }
    router.refresh();
  };

  if (editing) {
    return (
      <form className="rp-rename" onSubmit={(e) => { e.preventDefault(); void save(value); }}>
        <input ref={input} className="rp-rename__in" value={value} maxLength={80} aria-label="Series name" placeholder={guess}
          onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") { setEditing(false); setValue(name); } }} />
        <button type="submit" className="rp-cbtn rp-cbtn--pri" disabled={busy}><span className="rp-tick" aria-hidden="true" />Save</button>
        <button type="button" className="rp-cbtn" onClick={() => { setEditing(false); setValue(name); }}>Cancel</button>
        {name !== guess ? <button type="button" className="rp-cbtn" disabled={busy} onClick={() => void save("")}>Use “{guess}”</button> : null}
        {err ? <span className="rp-cta__note" role="alert">{err}</span> : null}
      </form>
    );
  }
  return (
    <>
      <button type="button" className="rp-cbtn" onClick={() => setEditing(true)}>Rename<span className="rp-kbd">R</span></button>
      {hidden
        ? <button type="button" className="rp-cbtn" disabled={busy} onClick={() => void hide(false)}>It is a series</button>
        : <button type="button" className="rp-cbtn" disabled={busy} onClick={() => void hide(true)}>Not a series</button>}
      {err ? <span className="rp-cta__note" role="alert">{err}</span> : null}
    </>
  );
}
