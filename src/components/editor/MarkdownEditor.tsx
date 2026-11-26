"use client";

// The notes editor: Markdown with a live preview (CodeMirror 6). Type "/" for commands, "[[" to
// link, select text for writing assist. Saves as you type; works with the server or the network
// gone (the draft stays in this browser until it saves).
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { LinkTarget } from "@/lib/editor/commands";
import { ASSIST_LABELS, ASSIST_MODES, type AssistMode } from "@/lib/editor/assist";
import { parseWikiLink } from "@/lib/editor/links";
import { editorExtensions } from "@/lib/editor/setup";
import { localLine } from "@/lib/editor/slash";
import { addItemFromNoteAction, assistAction, assistEstimateAction, createNoteAction, linkTargetsAction, setItemDoneFromNoteAction } from "@/app/notes-actions";
import { clearDraft, readDraft, useAutosave, type Draft, type SaveFn } from "./useAutosave";
import { structureExtensions } from "@/lib/structure/editor";
import { createTypedNoteAction, noteTypesAction } from "@/app/structure-actions";

export interface MarkdownEditorProps {
  /** Unique per document, for the offline draft ("note:q4-plan", "day:2026-11-26"). */
  docKey: string;
  initial: string;
  save: SaveFn;
  timeZone: string;
  today: string;
  placeholder?: string;
  label: string;
  assist: { enabled: boolean; reason?: string };
  /** Status shown before anything is typed. */
  idleText?: string;
  autoFocus?: boolean;
  /** Note titles, so [[Untyped]] links resolve to notes. */
  notes?: Array<{ slug: string; title: string }>;
}

type Bubble = { from: number; to: number; text: string; top: number; left: number };
type AssistRun = { mode: AssistMode; from: number; to: number; original: string; loading: boolean; text?: string; error?: string; cost?: string | null };

const STATUS: Record<string, string> = { saving: "Saving…", saved: "Saved", offline: "Offline: kept on this Mac, saves when it can" };

export function MarkdownEditor(p: MarkdownEditorProps) {
  const router = useRouter();
  const host = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const targets = useRef<LinkTarget[]>([]);
  const targetsAt = useRef(0);
  const noteTypes = useRef<Array<{ id: string; name: string }>>([]);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const [bubble, setBubble] = useState<Bubble | null>(null);
  const [estimate, setEstimate] = useState<string | null>(null);
  const [run, setRun] = useState<AssistRun | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflictDraft, setConflictDraft] = useState<Draft | null>(null);
  const autosave = useAutosave(p.docKey, p.initial, p.save);
  const auto = useRef(autosave);
  auto.current = autosave;
  const props = useRef(p);
  props.current = p;

  const loadTargets = useCallback(async (force = false) => {
    if (!force && Date.now() - targetsAt.current < 60_000) return;
    targetsAt.current = Date.now();
    try { targets.current = await linkTargetsAction(); } catch { /* offline: keep the last list */ }
    if (!noteTypes.current.length) noteTypes.current = await noteTypesAction().catch(() => []);
  }, []);

  const onSelection = useCallback((v: EditorView) => {
    const r = v.state.selection.main;
    if (r.empty || !v.hasFocus || !wrap.current) { setBubble((b) => (b && !bubbleRef.current?.contains(document.activeElement) ? null : b)); return; }
    const text = v.state.sliceDoc(r.from, r.to);
    if (!text.trim()) { setBubble(null); return; }
    const start = v.coordsAtPos(r.from), box = wrap.current.getBoundingClientRect();
    if (!start) return;
    setBubble({ from: r.from, to: r.to, text, top: start.top - box.top, left: Math.max(0, Math.min(start.left - box.left, box.width - 300)) });
  }, []);

  // Create the editor once; the document then lives in CodeMirror.
  useEffect(() => {
    if (!host.current) return;
    let doc = p.initial;
    const draft = readDraft(p.docKey);
    if (draft && draft.text !== p.initial) {
      // A draft made from this same file: it is newer, so carry on with it. Otherwise ask.
      if (draft.base === autosave.base) doc = draft.text;
      else setConflictDraft(draft);
    }
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc,
        extensions: editorExtensions(doc, {
          placeholder: p.placeholder,
          targets: () => { void loadTargets(); return targets.current; },
          newNote: async (title) => {
            const r = await createNoteAction(title).catch(() => null);
            if (r?.ok) void loadTargets(true);
            return r?.ok ? r.slug : null;
          },
          today: () => props.current.today,
          lineCommands: {
            run: async (cmd) => {
              if (cmd.id === "decision" || cmd.id === "date") return localLine({ id: cmd.id, arg: cmd.arg, indent: cmd.indent }, new Date(), props.current.timeZone);
              setNotice("Adding…");
              const r = await addItemFromNoteAction({ id: cmd.id, arg: cmd.arg, indent: cmd.indent }).catch(() => ({ ok: false as const, error: "Couldn't reach Daily brief. The line stays; press Enter on it again later." }));
              setNotice(r.ok ? (cmd.id === "waiting" ? "Added to Waiting on" : "Added to your items") : r.error);
              if (r.ok) { void loadTargets(true); router.refresh(); }
              return r.ok ? r.line : null;
            },
          },
          preview: {
            resolver: () => ({ notes: props.current.notes }),
            navigate: (href, newTab) => { void auto.current.flush(); if (newTab) window.open(href, "_blank"); else router.push(href); },
            onTask: (line, checked) => {
              const m = line.match(/\[\[item:[^\]]+\]\]/);
              const l = m ? parseWikiLink(m[0]) : null;
              if (l?.kind === "item") void setItemDoneFromNoteAction(l.target, checked).then((r) => { if (r.ok) { setNotice(checked ? "Marked done" : "Reopened"); router.refresh(); } }).catch(() => {});
            },
          },
          keys: [
            { key: "Mod-s", run: () => { void auto.current.flush(); return true; } },
            { key: "Mod-j", run: () => { const b = bubbleRef.current?.querySelector("button"); if (b) { (b as HTMLButtonElement).focus(); return true; } return false; } },
          ],
          onChange: (text) => auto.current.change(text),
          onSelection,
          ...structureExtensions({
            types: () => { if (!noteTypes.current.length) void noteTypesAction().then((t) => { noteTypes.current = t; }).catch(() => {}); return noteTypes.current; },
            create: async (typeId, title) => {
              const r = await createTypedNoteAction(typeId, title).catch(() => null);
              setNotice(r?.ok ? `Made “${r.title}”` : r?.error ?? "Couldn't reach Daily brief.");
              if (r?.ok) void loadTargets(true);
              return r?.ok ? r : null;
            },
          }),
        }),
      }),
    });
    view.current = v;
    v.contentDOM.setAttribute("aria-label", p.label);
    if (doc !== p.initial) auto.current.change(doc);
    if (p.autoFocus) v.focus();
    return () => { v.destroy(); view.current = null; };
    // The editor is created once per document (callers key it by docKey).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Estimate for the selection, after it settles.
  useEffect(() => {
    setEstimate(null);
    if (!bubble || !p.assist.enabled) return;
    const t = setTimeout(() => { void assistEstimateAction("tidy", bubble.text).then((r) => setEstimate(r.costLabel)).catch(() => {}); }, 350);
    return () => clearTimeout(t);
  }, [bubble, p.assist.enabled]);

  useEffect(() => { if (!bubble) setRun(null); }, [bubble]);

  useEffect(() => {
    if (!notice || notice === "Adding…") return;
    const t = setTimeout(() => setNotice(null), 2500);
    return () => clearTimeout(t);
  }, [notice]);

  const startAssist = async (mode: AssistMode) => {
    if (!bubble || !p.assist.enabled) return;
    const job: AssistRun = { mode, from: bubble.from, to: bubble.to, original: bubble.text, loading: true };
    setRun(job);
    const r = await assistAction(mode, bubble.text).catch(() => ({ ok: false as const, error: "Couldn't reach Daily brief.", costLabel: null }));
    setRun((cur) => (cur && cur.from === job.from && cur.mode === mode ? { ...job, loading: false, text: r.ok ? r.text : undefined, error: r.ok ? undefined : r.error, cost: r.costLabel ?? null } : cur));
    if (!r.ok && /key|credit/i.test(r.error)) router.refresh();
  };

  const applyAssist = (how: "replace" | "below") => {
    const v = view.current;
    if (!v || !run?.text) return;
    const same = v.state.sliceDoc(run.from, run.to) === run.original;
    if (how === "replace" && same) {
      v.dispatch({ changes: { from: run.from, to: run.to, insert: run.text }, selection: { anchor: run.from + run.text.length }, userEvent: "input.assist" });
    } else {
      const at = same ? v.state.doc.lineAt(run.to).to : v.state.selection.main.head;
      const ins = `${v.state.lineBreak}${v.state.lineBreak}${run.text.trim()}`;
      v.dispatch({ changes: { from: at, insert: ins }, selection: { anchor: at + ins.length }, userEvent: "input.assist" });
    }
    setRun(null);
    setBubble(null);
    v.focus();
  };

  const closeAssist = () => { setRun(null); view.current?.focus(); };

  const onBubbleKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); setBubble(null); closeAssist(); return; }
    const n = Number(e.key);
    if (!run && n >= 1 && n <= ASSIST_MODES.length) { e.preventDefault(); void startAssist(ASSIST_MODES[n - 1]); }
    if (run?.text && e.key === "Enter" && !(e.target as HTMLElement).closest("button")) { e.preventDefault(); applyAssist("replace"); }
  };

  const restore = (d: Draft) => {
    const v = view.current;
    if (!v) return;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: d.text } });
    setConflictDraft(null);
  };

  const s = autosave.state;
  const status = notice ?? (s === "error" ? autosave.error ?? "Couldn't save." : STATUS[s] ?? p.idleText ?? "");

  return (
    <div className="db-ed" ref={wrap}>
      <div className="db-ed__bar">
        <span className={`db-ed__status${s === "error" || s === "offline" ? " db-ed__status--warn" : ""}`} aria-live="polite">{status}</span>
        <span className="db-ed__keys" aria-hidden="true"><kbd>/</kbd> commands <kbd>[[</kbd> link <kbd>⌘J</kbd> assist</span>
      </div>
      {conflictDraft ? (
        <p className="db-ed__draft" role="status">
          <span>Unsaved changes from {new Date(conflictDraft.at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} differ from the file, which changed since.</span>
          <button className="db-act" type="button" onClick={() => restore(conflictDraft)}>Restore them</button>
          <button className="db-act" type="button" onClick={() => { clearDraft(p.docKey); setConflictDraft(null); }}>Discard</button>
        </p>
      ) : null}
      <div className="db-ed__host" ref={host} onFocus={() => { void loadTargets(); }} onBlur={() => { void autosave.flush(); }} />
      {bubble ? (
        <div className="db-ed__assist" ref={bubbleRef} style={{ top: bubble.top, left: bubble.left }} role="toolbar" aria-label="Writing assist" onKeyDown={onBubbleKey} onMouseDown={(e) => { if (!(e.target as HTMLElement).closest(".db-ed__result-text")) e.preventDefault(); }}>
          {run ? (
            <div className="db-ed__result">
              <div className="db-ed__result-head">
                <b>{ASSIST_LABELS[run.mode]}</b>
                <span className="db-ed__cost">{run.loading ? "Asking Claude…" : run.cost ? `Cost ${run.cost}` : ""}</span>
              </div>
              {run.loading ? <p className="db-ed__result-text db-ed__result-text--wait">…</p> : run.error ? <p className="db-ed__result-error" role="alert">{run.error}</p> : <p className="db-ed__result-text" tabIndex={0}>{run.text}</p>}
              <div className="db-ed__result-acts">
                {run.text ? <button className="db-act db-act--primary" type="button" autoFocus onClick={() => applyAssist("replace")}>Replace</button> : null}
                {run.text ? <button className="db-act" type="button" onClick={() => applyAssist("below")}>Insert below</button> : null}
                {run.text ? <button className="db-act" type="button" onClick={() => { void navigator.clipboard?.writeText(run.text!.trim()); setNotice("Copied"); }}>Copy</button> : null}
                <button className="db-act" type="button" onClick={closeAssist}>{run.text ? "Discard" : "Close"}</button>
              </div>
            </div>
          ) : p.assist.enabled ? (
            <>
              {ASSIST_MODES.map((m, i) => (
                <button key={m} className="db-ed__assist-btn" type="button" onClick={() => void startAssist(m)} title={`${ASSIST_LABELS[m]} (${i + 1})`}>
                  {m === "slack" ? "Slack message" : m === "translate" ? "Hinglish → English" : ASSIST_LABELS[m]}
                </button>
              ))}
              <span className="db-ed__cost" title="Estimated cost with your Anthropic key">{estimate ? `≈ ${estimate}` : ""}</span>
            </>
          ) : (
            <span className="db-ed__assist-off">{p.assist.reason ?? "Writing assist is off."}</span>
          )}
        </div>
      ) : null}
    </div>
  );
}
