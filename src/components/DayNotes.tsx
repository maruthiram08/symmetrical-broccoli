"use client";

// Your own notes on a day, saved into that day's .md (between markers) as you type.
import { useEffect, useRef, useState } from "react";
import { saveDayNotesAction } from "@/app/capture-actions";

const DELAY = 700;

export function DayNotes({ date, initial }: { date: string; initial: string }) {
  const [text, setText] = useState(initial);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const saved = useRef(initial);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(text);
  latest.current = text;

  const save = async () => {
    const value = latest.current;
    if (value === saved.current) return;
    setState("saving");
    const r = await saveDayNotesAction(date, value).catch(() => ({ ok: false as const, error: "Couldn't save." }));
    if (r.ok) { saved.current = value; setState(latest.current === value ? "saved" : "saving"); setError(null); }
    else { setState("error"); setError(r.error); }
  };

  useEffect(() => {
    if (text === saved.current) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void save(); }, DELAY);
    return () => { if (timer.current) clearTimeout(timer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  // Leaving the page (or closing the window) saves what's left.
  useEffect(() => {
    const flush = () => {
      if (latest.current !== saved.current) void saveDayNotesAction(date, latest.current);
    };
    window.addEventListener("pagehide", flush);
    return () => { window.removeEventListener("pagehide", flush); flush(); };
  }, [date]);

  const status = state === "saving" ? "Saving…" : state === "saved" ? "Saved to the note" : state === "error" ? error ?? "Couldn't save." : "Saved in the day's .md, kept when the brief is written again.";
  return (
    <section className="db-section db-daynotes">
      <div className="db-section__head">
        <h2 className="db-section__title" id="db-daynotes-title">Your notes</h2>
        <span className={`db-daynotes__status${state === "error" ? " db-daynotes__status--error" : ""}`} aria-live="polite">{status}</span>
      </div>
      <textarea
        className="db-input db-daynotes__text"
        aria-labelledby="db-daynotes-title"
        value={text}
        onChange={(e) => { setText(e.target.value); if (state !== "saving") setState("idle"); }}
        onBlur={() => { void save(); }}
        placeholder="What else happened, what to remember tomorrow…"
        rows={6}
        spellCheck
      />
    </section>
  );
}
