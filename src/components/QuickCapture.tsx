"use client";

// Quick capture: "c" anywhere (or ⌘K › Add…, or the menu bar's Quick add…) opens one line.
// Type "send Nitin the deck by Fri"; the line is read here, with no AI, into kind, person and due
// date, which you can change before saving. The same dialog edits and deletes items you added.
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState, useTransition } from "react";
import { addItemAction, captureContextAction, deleteItemAction, updateItemAction } from "@/app/capture-actions";
import { parseCapture } from "@/lib/capture/parse";
import { localDate } from "@/lib/brief/time";

/** Open quick capture from anywhere: `window.dispatchEvent(new CustomEvent(OPEN_CAPTURE, { detail }))`. */
export const OPEN_CAPTURE = "db:capture";

export interface CaptureDetail {
  /** Start with this line typed. */
  text?: string;
  /** Edit one of your own items instead of adding. */
  edit?: { id: string; kind: "owe" | "waiting"; text: string; person: string | null; dueDate: string | null; note: string | null; dueAt?: string | null };
}

interface Ctx { people: string[]; self: string[]; timeZone: string }

type Field = "kind" | "person" | "dueDate";

function typing(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

/** "Fri 27 Nov" for a local date. */
function dayLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}

export function QuickCapture() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [line, setLine] = useState("");
  const [more, setMore] = useState(false);
  const [ctx, setCtx] = useState<Ctx | null>(null);
  // Fields you set by hand win over what the line says.
  const [manual, setManual] = useState<Partial<{ kind: "owe" | "waiting"; person: string; dueDate: string }>>({});
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const input = useRef<HTMLInputElement>(null);
  const restore = useRef<HTMLElement | null>(null);
  const ids = useId();

  const show = useCallback((d: CaptureDetail = {}) => {
    restore.current = document.activeElement as HTMLElement | null;
    setError(null);
    if (d.edit) {
      setEditId(d.edit.id);
      setLine(d.edit.text);
      setManual({ kind: d.edit.kind, person: d.edit.person ?? "", dueDate: d.edit.dueDate ?? "" });
      setNote(d.edit.note ?? "");
      setMore(true);
    } else {
      setEditId(null);
      setLine(d.text ?? "");
      setManual({});
      setNote("");
      setMore(false);
    }
    setOpen(true);
    const dueAt = d.edit?.dueAt;
    void captureContextAction().then((c) => {
      if (!c) return;
      setCtx(c);
      // The due date as a day in your zone, unless you've already changed it.
      if (dueAt) setManual((m) => (m.dueDate === d.edit?.dueDate ? { ...m, dueDate: localDate(new Date(dueAt), c.timeZone) } : m));
    }).catch(() => {});
  }, []);
  const close = useCallback(() => { setOpen(false); restore.current?.focus?.(); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "c" || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      show();
    };
    const onOpen = (e: Event) => show((e as CustomEvent<CaptureDetail | undefined>).detail ?? {});
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_CAPTURE, onOpen);
    // The menu bar's Quick add… opens the window on /?capture=1.
    const url = new URL(window.location.href);
    if (url.searchParams.get("capture") === "1") {
      url.searchParams.delete("capture");
      window.history.replaceState(null, "", url.pathname + url.search + url.hash);
      show();
    }
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener(OPEN_CAPTURE, onOpen); };
  }, [show]);

  useEffect(() => { if (open) requestAnimationFrame(() => input.current?.focus()); }, [open]);

  const parsed = useMemo(() => parseCapture(line, {
    people: ctx?.people ?? [], self: ctx?.self ?? [], now: new Date(),
    timeZone: ctx?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  }), [line, ctx]);

  // When editing, the text is saved as typed; when adding, the line is read.
  const kind = manual.kind ?? parsed.kind;
  const person = manual.person !== undefined ? manual.person : parsed.person ?? "";
  const dueDate = manual.dueDate !== undefined ? manual.dueDate : parsed.dueDate ?? "";
  const text = editId ? line.trim() : parsed.text;
  const set = (f: Field, v: string) => setManual((m) => ({ ...m, [f]: v }));

  const save = () => {
    if (!line.trim() || pending) return;
    const input = { kind, text, person: person.trim() || null, dueDate: dueDate || null, note: note.trim() || null };
    start(async () => {
      const r = editId ? await updateItemAction(editId, input) : await addItemAction(input);
      if (!r.ok) { setError(r.error); return; }
      close();
      router.refresh();
    });
  };
  const remove = () => {
    if (!editId || pending) return;
    start(async () => {
      const r = await deleteItemAction(editId);
      if (!r.ok) { setError(r.error); return; }
      close();
      router.refresh();
    });
  };

  if (!open) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "Enter" && (e.target as HTMLElement).tagName !== "TEXTAREA" && (e.target as HTMLElement).tagName !== "BUTTON") { e.preventDefault(); save(); }
    else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
  };

  return (
    <div className="db-palette-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="db-palette db-capture" role="dialog" aria-modal="true" aria-label={editId ? "Edit your item" : "Quick add"} onKeyDown={onKeyDown}>
        <div className="db-palette__input">
          <span className={`db-mark db-mark--${kind}`} aria-hidden="true" />
          <input
            ref={input}
            value={line}
            onChange={(e) => { setLine(e.target.value); setError(null); }}
            placeholder="send Nitin the deck by Fri · Tarun owes me the API spec tomorrow"
            aria-label={editId ? "What it is" : "Add something you owe or are waiting on"}
            aria-describedby={`${ids}-preview`}
            autoComplete="off"
            spellCheck={false}
            maxLength={300}
          />
          <span className="db-kbd">esc</span>
        </div>

        <div className="db-capture__preview" id={`${ids}-preview`} aria-live="polite">
          <div className="db-capture__seg" role="group" aria-label="Kind">
            <button type="button" aria-pressed={kind === "owe"} onClick={() => set("kind", "owe")}>You owe</button>
            <button type="button" aria-pressed={kind === "waiting"} onClick={() => set("kind", "waiting")}>Waiting on</button>
          </div>
          {line.trim() ? (
            <span className="db-capture__read">
              {editId ? null : <span className="db-capture__text">{text}</span>}
              {person ? <span className="db-capture__chip">{person}</span> : null}
              {dueDate ? <span className="db-capture__chip db-capture__chip--due">{dayLabel(dueDate)}</span> : null}
            </span>
          ) : (
            <span className="db-capture__hint">Names, “today”, “tomorrow”, a weekday or a date are picked up as you type.</span>
          )}
        </div>

        {more ? (
          <div className="db-capture__fields">
            <label className="db-capture__field">
              <span>Person</span>
              <input className="db-input" list={`${ids}-people`} value={person} onChange={(e) => set("person", e.target.value)} placeholder="No one" maxLength={80} />
              <datalist id={`${ids}-people`}>{(ctx?.people ?? []).map((p) => <option key={p} value={p} />)}</datalist>
            </label>
            <label className="db-capture__field">
              <span>Due</span>
              <input className="db-input" type="date" value={dueDate} onChange={(e) => set("dueDate", e.target.value)} />
            </label>
            <label className="db-capture__field db-capture__field--wide">
              <span>Note</span>
              <textarea className="db-input db-capture__note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={2000} placeholder="Anything to remember about it" />
            </label>
          </div>
        ) : null}

        {error ? <p className="db-capture__error" role="alert">{error}</p> : null}

        <div className="db-palette__foot db-capture__foot">
          {editId ? (
            <button type="button" className="db-act db-act--danger" onClick={remove} disabled={pending}>Delete</button>
          ) : (
            <button type="button" className="db-act" onClick={() => setMore((m) => !m)} aria-expanded={more}>{more ? "Fewer details" : "Person, due, note…"}</button>
          )}
          <span className="db-palette__foot-end">
            <button type="button" className="db-act db-act--primary" onClick={save} disabled={pending || !line.trim()}>
              {pending ? "Saving…" : editId ? "Save" : "Add"} <span className="db-kbd">↵</span>
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
