"use client";

// Autosave for the notes editor: saves a moment after you stop typing, on blur, when you leave
// the page and when the Mac comes back online. Until a save lands, the text is also kept in this
// browser (localStorage), so a closed window or a stopped server never loses it.
import { useCallback, useEffect, useRef, useState } from "react";

export type SaveFn = (text: string) => Promise<{ ok: true } | { ok: false; error: string }>;
export type SaveState = "idle" | "saving" | "saved" | "offline" | "error";

const DELAY = 600;
const RETRY_MIN = 3000;
const RETRY_MAX = 60_000;

/** A small, fast string hash (FNV-1a), to tell whether a draft was made from this file. */
export function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

export interface Draft { text: string; base: string; at: string }
const draftKey = (k: string) => `db-note-draft:${k}`;

export function readDraft(key: string): Draft | null {
  try {
    const raw = localStorage.getItem(draftKey(key));
    const d = raw ? JSON.parse(raw) as Draft : null;
    return d && typeof d.text === "string" && typeof d.base === "string" ? d : null;
  } catch { return null; }
}
function writeDraft(key: string, d: Draft) { try { localStorage.setItem(draftKey(key), JSON.stringify(d)); } catch { /* storage off: the server save still runs */ } }
export function clearDraft(key: string) { try { localStorage.removeItem(draftKey(key)); } catch { /* ignore */ } }

export function useAutosave(key: string, initial: string, save: SaveFn) {
  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const saved = useRef(initial);
  const latest = useRef(initial);
  const base = useRef(fnv(initial));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retry = useRef(RETRY_MIN);
  const inFlight = useRef<Promise<void> | null>(null);
  const saveRef = useRef(save);
  saveRef.current = save;

  const flush = useCallback(async (): Promise<void> => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (inFlight.current) { await inFlight.current; }
    const value = latest.current;
    if (value === saved.current) return;
    setState("saving");
    const run = (async () => {
      let r: Awaited<ReturnType<SaveFn>> | null = null;
      try { r = await saveRef.current(value); } catch { r = null; }
      if (r?.ok) {
        saved.current = value;
        retry.current = RETRY_MIN;
        if (latest.current === value) { clearDraft(key); setState("saved"); } else setState("saving");
        setError(null);
      } else {
        // No answer means the server is down or the window is offline: keep the draft and retry.
        setState(r ? "error" : "offline");
        setError(r && !r.ok ? r.error : null);
        timer.current = setTimeout(() => { void flush(); }, retry.current);
        retry.current = Math.min(RETRY_MAX, retry.current * 2);
      }
    })();
    inFlight.current = run;
    await run;
    inFlight.current = null;
    if (latest.current !== saved.current && !timer.current) timer.current = setTimeout(() => { void flush(); }, DELAY);
  }, [key]);

  const change = useCallback((text: string) => {
    latest.current = text;
    if (text === saved.current) { clearDraft(key); return; }
    writeDraft(key, { text, base: base.current, at: new Date().toISOString() });
    setState((s) => (s === "offline" || s === "error" ? s : "idle"));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void flush(); }, DELAY);
  }, [flush, key]);

  useEffect(() => {
    const now = () => { void flush(); };
    const hidden = () => { if (document.visibilityState === "hidden") void flush(); };
    window.addEventListener("online", now);
    window.addEventListener("pagehide", now);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("online", now);
      window.removeEventListener("pagehide", now);
      document.removeEventListener("visibilitychange", hidden);
      void flush();
    };
  }, [flush]);

  return { state, error, change, flush, base: base.current };
}
