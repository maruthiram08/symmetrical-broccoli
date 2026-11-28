"use client";

// The buttons on a person and on a found thread. Nothing runs on load: the update and "Where it
// stands" are written by AI only when you press, and Keep is the only thing that files items.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { dismissThreadAction, dropItemAction, keepThreadAction, personUpdateAction, whereItStandsAction } from "@/app/thread-actions";
import { removeProjectAction } from "@/app/structure-actions";

const WRITE_EVENT = "rp:write-update";

async function copy(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

const typing = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  return e.metaKey || e.ctrlKey || e.altKey || !!t?.closest("input, textarea, select, [contenteditable='true']");
};

/** Runs `run` on a bare key press (not while typing). */
function useKey(key: string | undefined, run: () => void) {
  useEffect(() => {
    if (!key) return;
    const on = (e: KeyboardEvent) => { if (!typing(e) && e.key.toLowerCase() === key.toLowerCase()) { e.preventDefault(); run(); } };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [key, run]);
}

function useFlash(): [string | null, (s: string) => void] {
  const [flash, set] = useState<string | null>(null);
  return [flash, (s: string) => { set(s); setTimeout(() => set(null), 2000); }];
}

/** A button that copies text, with an optional key. */
export function CopyButton({ text, label, k, pri }: { text: string; label: string; k?: string; pri?: boolean }) {
  const [flash, show] = useFlash();
  const run = () => { void copy(text).then((ok) => show(ok ? "Copied" : "Couldn't copy")); };
  useKey(k, run);
  return (
    <button type="button" className={`rp-cbtn${pri ? " rp-cbtn--pri" : ""}`} onClick={run}>
      {pri ? <span className="rp-tick" aria-hidden="true" /> : null}{flash ?? label}{k ? <span className="rp-kbd">{k.toUpperCase()}</span> : null}
    </button>
  );
}

/** "Send X an update" (key U): asks the draft below to write itself. */
export function UpdateButton({ name }: { name: string }) {
  const run = () => { window.dispatchEvent(new Event(WRITE_EVENT)); document.getElementById("rp-update")?.scrollIntoView({ block: "nearest", behavior: "smooth" }); };
  useKey("u", run);
  return <button type="button" className="rp-cbtn rp-cbtn--pri" onClick={run}><span className="rp-tick" aria-hidden="true" />Send {name} an update<span className="rp-kbd">U</span></button>;
}

/** The update, ready to send: the plain template until you ask for it written. */
export function UpdateDraft({ slug, template, drop }: { slug: string; template: string; drop?: { id: string; label: string } }) {
  const router = useRouter();
  const [text, setText] = useState(template);
  const [state, setState] = useState<"template" | "busy" | "ai" | "fallback">("template");
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, show] = useFlash();
  useEffect(() => { setText(template); setState("template"); }, [template]);
  useEffect(() => {
    const write = () => {
      setState("busy");
      void personUpdateAction(slug).then((r) => {
        if (!r.ok) { setError(r.error); setState("template"); return; }
        setText(r.text); setState(r.ai ? "ai" : "fallback"); setError(null);
      });
    };
    window.addEventListener(WRITE_EVENT, write);
    return () => window.removeEventListener(WRITE_EVENT, write);
  }, [slug]);
  const lines = text.split("\n");
  return (
    <div className="rp-draft" id="rp-update" aria-busy={state === "busy" || undefined}>
      {editing
        ? <textarea className="rp-draft__edit" value={text} rows={Math.min(14, lines.length + 2)} onChange={(e) => setText(e.target.value)} aria-label="Update text" />
        : <div className="rp-draft__body">{renderSlack(lines)}</div>}
      <div className="rp-draft__ft">
        <button type="button" className="rp-btn2 rp-btn2--pri" onClick={() => void copy(text).then((ok) => show(ok ? "Copied for Slack" : "Couldn't copy"))}>{flash ?? "Copy for Slack"}</button>
        <button type="button" className="rp-btn2" onClick={() => setEditing((x) => !x)}>{editing ? "Done" : "Edit"}</button>
        {drop ? <button type="button" className="rp-btn2" title="It wasn't a promise" onClick={() => void dropItemAction(drop.id).then((r) => { if (r.ok) router.refresh(); else setError(r.error); })}>Drop {drop.label}</button> : null}
        <span className="rp-draft__src">
          {state === "busy" ? "Writing…" : state === "ai" ? "Written by AI from what's open" : state === "fallback" ? "From the template: set a provider for Nudges in Settings › AI" : "From the template · Send an update to have it written"}
        </span>
      </div>
      {error ? <p className="rp-draft__err" role="alert">{error}</p> : null}
    </div>
  );
}

function renderSlack(lines: string[]): ReactNode {
  const out: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => { if (list.length) out.push(<ul key={`u${out.length}`}>{list.map((l, n) => <li key={n}>{l}</li>)}</ul>); list = []; };
  for (const l of lines) {
    const b = l.match(/^\s*[•\-*]\s+(.*)$/);
    if (b) list.push(b[1]);
    else { flush(); if (l.trim()) out.push(<p key={`p${out.length}`}>{l}</p>); }
  }
  flush();
  return out;
}

/** Where it stands: the cached AI text, else the plain summary, and a button to (re)write it. */
export function StandsCard({ id, text, ai, stale, meetings, sources }: { id: string; text: string; ai: boolean; stale: boolean; meetings: number; sources: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const write = () => {
    setBusy(true);
    void whereItStandsAction(id).then((r) => { setBusy(false); if (r.ok) { setError(null); router.refresh(); } else setError(r.error); });
  };
  return (
    <div className="rp-where" aria-busy={busy || undefined}>
      <p>{text}</p>
      <div className="rp-where__ft">
        <span>{ai ? `Written from ${meetings} meetings` : `From ${meetings} meetings, not AI`}{stale ? " · out of date" : ""}</span>
        <span aria-hidden="true">·</span>
        <a href={sources}>See the sources</a>
        <span className="rp-sp" />
        <button type="button" className="rp-btn2" onClick={write} disabled={busy}>{busy ? "Writing…" : ai ? (stale ? "Rewrite" : "Write again") : "Write with AI"}</button>
      </div>
      {error ? <p className="rp-draft__err" role="alert">{error}</p> : null}
    </div>
  );
}

/** Keep as a project / Not one thread. Keep files the thread's items as yours; Undo takes it back. */
export function ThreadButtons({ id, name }: { id: string; name: string }) {
  const router = useRouter();
  const [kept, setKept] = useState<{ slug: string; filed: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keep = () => {
    setBusy(true);
    void keepThreadAction(id).then((r) => { setBusy(false); if (r.ok) { setKept({ slug: r.slug, filed: r.filed }); setError(null); } else setError(r.error); });
  };
  const undo = () => {
    if (!kept) return;
    setBusy(true);
    void removeProjectAction(kept.slug, { undo: true }).then((r) => { setBusy(false); if (r.ok) { setKept(null); router.refresh(); } else setError(r.error); });
  };
  const dismiss = () => {
    setBusy(true);
    void dismissThreadAction(id).then((r) => { setBusy(false); if (r.ok) router.push(`/projects?hidden=${encodeURIComponent(id)}`); else setError(r.error); });
  };
  if (kept) {
    return (
      <span className="rp-kept" role="status">
        Kept as a project, {kept.filed} filed.{" "}
        <Link className="db-link" href={`/projects?project=${encodeURIComponent(kept.slug)}`}>Open {name}</Link>{" "}
        <button type="button" className="rp-btn2" onClick={undo} disabled={busy}>Undo</button>
      </span>
    );
  }
  return (
    <>
      <button type="button" className="rp-cbtn" onClick={keep} disabled={busy}>Keep as a project</button>
      <button type="button" className="rp-cbtn" onClick={dismiss} disabled={busy}>Not one thread</button>
      {error ? <span className="rp-draft__err" role="alert">{error}</span> : null}
    </>
  );
}

/** "Hidden <name>. Undo" after Not one thread. */
export function HiddenFlash({ id }: { id: string }) {
  const router = useRouter();
  const [gone, setGone] = useState(false);
  if (gone) return null;
  return (
    <p className="rp-lflash" role="status">
      Hidden. It won&apos;t be suggested again.{" "}
      <button type="button" className="rp-btn2" onClick={() => void dismissThreadAction(id, false).then(() => { setGone(true); router.replace(`/projects?project=${encodeURIComponent(`thread:${id}`)}`); })}>Undo</button>
    </p>
  );
}
