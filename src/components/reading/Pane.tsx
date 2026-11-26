"use client";

// The reading pane's client half: which row is selected (kept in the URL, ?item=<id>), the keys,
// "Show N more", the list's rows and the detail header's ↑ ↓ and "N of M".
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { setStatus } from "@/app/actions";
import { afterRemoving, backUrl, groupHiding, keyCommand, step, visibleIds, SHOW_LIMIT, type Group, type KeyCommand, type Row } from "@/lib/reading/model";
import { OPEN_CAPTURE, type CaptureDetail } from "../QuickCapture";

/** Sent on window for a key the detail pane acts on (done, snooze, star…). */
export const RP_ACT = "rp:act";

interface Ctx {
  param: string;
  selected: string | null;
  visible: string[];
  expanded: ReadonlySet<string>;
  select: (id: string | null) => void;
  toggle: (key: string) => void;
  /** Where an action on `id` should land, with the selection moved on when `id` leaves. */
  backFor: (id: string, leaves: boolean, undo?: "done" | "wrong") => string;
}

const ReadingCtx = createContext<Ctx | null>(null);
export const useReading = () => useContext(ReadingCtx);

function typing(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

export interface ReadingSetup {
  groups: Array<{ key: string; ids: string[] }>;
  /** The URL parameter that holds the selection: "item", or "project" on Projects. */
  param: string;
  selected: string | null;
  /** The selection was picked by the page (first row), not by you: phones show the list first. */
  auto?: boolean;
  /** Parameters dropped when the selection changes (Projects: picking a project drops ?item). */
  clear?: string[];
}

export function ReadingProvider({ groups, param, selected: initial, auto = false, clear = [], children }: ReadingSetup & { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [selected, setSelected] = useState<string | null>(initial);
  const [explicit, setExplicit] = useState(!auto && !!initial);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set([groupHiding(groups, initial)].filter((k): k is string => !!k)));
  useEffect(() => { setSelected(initial); setExplicit(!auto && !!initial); }, [initial, auto]);

  const visible = useMemo(() => visibleIds(groups, expanded), [groups, expanded]);
  const clearKey = clear.join(",");

  const select = useCallback((id: string | null) => {
    setSelected(id);
    setExplicit(!!id);
    const q = new URLSearchParams(window.location.search);
    for (const k of clearKey ? clearKey.split(",") : []) q.delete(k);
    q.delete("undo"); q.delete("was");
    if (id) q.set(param, id); else q.delete(param);
    const s = q.toString();
    router.replace(`${pathname}${s ? `?${s}` : ""}`, { scroll: false });
  }, [router, pathname, param, clearKey]);

  const toggle = useCallback((key: string) => {
    setExpanded((e) => { const n = new Set(e); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  }, []);

  const backFor = useCallback((id: string, leaves: boolean, undo?: "done" | "wrong") => {
    const next = leaves && selected === id ? afterRemoving(visible, id) : selected;
    return backUrl(pathname, typeof window === "undefined" ? "" : window.location.search, param, next, undo ? { id, was: undo } : undefined);
  }, [pathname, param, selected, visible]);

  // Keep the selected row in view.
  useEffect(() => {
    if (!selected) return;
    document.querySelector<HTMLElement>(`[data-rp-row="${CSS.escape(selected)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected, expanded]);

  const state = useRef({ selected, visible, select });
  state.current = { selected, visible, select };

  useEffect(() => {
    let g = 0;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      if (document.querySelector('[aria-modal="true"], [data-menu-open="true"]')) return;
      if (e.key === "g") { g = Date.now(); return; }
      if (g && Date.now() - g < 1200) { g = 0; return; } // "g t", "g o", "g p" belong to Keys
      const cmd = keyCommand(e.key, e.shiftKey);
      if (!cmd) return;
      const s = state.current;
      if (cmd === "next" || cmd === "prev") {
        const to = step(s.visible, s.selected, cmd === "next" ? 1 : -1);
        if (!to) return;
        e.preventDefault();
        if (to !== s.selected) s.select(to);
        return;
      }
      if (!s.selected && cmd !== "close") return;
      e.preventDefault();
      window.dispatchEvent(new CustomEvent<KeyCommand>(RP_ACT, { detail: cmd }));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const value = useMemo<Ctx>(() => ({ param, selected, visible, expanded, select, toggle, backFor }), [param, selected, visible, expanded, select, toggle, backFor]);
  return (
    <ReadingCtx.Provider value={value}>
      <div className="rp-panes" data-rp-keys="" data-show={selected && explicit ? "detail" : "list"}>{children}</div>
    </ReadingCtx.Provider>
  );
}

/** Listen for one of the reading pane's key commands. */
export function useRpAct(handler: (cmd: KeyCommand) => void) {
  const h = useRef(handler);
  h.current = handler;
  useEffect(() => {
    const on = (e: Event) => h.current((e as CustomEvent<KeyCommand>).detail);
    window.addEventListener(RP_ACT, on);
    return () => window.removeEventListener(RP_ACT, on);
  }, []);
}

// ---------- list ----------

/** The Done checkbox at the start of a row: the mark, shaped by kind. */
export function RowCheck({ row }: { row: Pick<Row, "id" | "mark" | "done" | "kind"> }) {
  const r = useReading();
  const field = useRef<HTMLInputElement>(null);
  if (row.kind === "decision") return <span className="rp-chk" aria-hidden="true"><span className="rp-m rp-m--decision" /></span>;
  return (
    <form action={setStatus} className="rp-chkform">
      <input type="hidden" name="id" value={row.id} />
      <input type="hidden" name="status" value={row.done ? "open" : "done"} />
      <input type="hidden" name="back" defaultValue="" ref={field} />
      <button
        type="submit"
        className="rp-chk"
        aria-label={row.done ? "Mark open" : "Mark done"}
        title={row.done ? "Mark open" : "Mark done"}
        onClick={(e) => {
          e.stopPropagation();
          if (field.current) field.current.value = r ? r.backFor(row.id, false, row.done ? undefined : "done") : "";
        }}
      >
        <span className={`rp-m rp-m--${row.mark}`}>
          {row.done ? <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="var(--bg)" strokeWidth="2.4" aria-hidden="true"><path d="M2 6.5 5 9l5-6" /></svg> : null}
        </span>
      </button>
    </form>
  );
}

export function ListRow({ row, href }: { row: Row; href: string }) {
  const r = useReading();
  const sel = r?.selected === row.id;
  return (
    <div className={`rp-row${sel ? " rp-row--sel" : ""}${row.done ? " rp-row--done" : ""}`} data-rp-row={row.id} aria-current={sel ? "true" : undefined}>
      <RowCheck row={row} />
      <div className="rp-row__body">
        <Link
          className="rp-row__t"
          href={href}
          replace
          scroll={false}
          onClick={(e) => { if (r && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) { e.preventDefault(); r.select(row.id); } }}
        >
          {row.title}
        </Link>
        {row.quote ? <div className="rp-row__q">&ldquo;{row.quote}&rdquo;</div> : null}
        <div className="rp-row__s">{row.meta}</div>
      </div>
      <span className={`rp-badge${row.late ? " rp-badge--late" : ""}`}>{row.badge}</span>
    </div>
  );
}

/** Jump chips, then each group: sticky header, its first rows, then "Show N more". */
export function ListGroups({ groups, hrefBase }: { groups: Group[]; hrefBase: string }) {
  const r = useReading();
  const sep = hrefBase.includes("?") ? "&" : "?";
  return (
    <>
      {groups.length > 1 ? (
        <nav className="rp-chips" aria-label="Jump to">
          {groups.map((g) => (
            <a key={g.key} className="rp-chip" href={`#rp-g-${g.key}`} onClick={(e) => { e.preventDefault(); document.getElementById(`rp-g-${g.key}`)?.scrollIntoView({ block: "start" }); }}>
              <b>{g.rows.length}</b>{g.short}
            </a>
          ))}
        </nav>
      ) : null}
      <div className="rp-scroll" data-rp-list="">
        {groups.map((g) => {
          const open = r?.expanded.has(g.key) ?? false;
          const shown = open || g.rows.length <= SHOW_LIMIT ? g.rows : g.rows.slice(0, SHOW_LIMIT);
          return (
            <section key={g.key} aria-labelledby={`rp-g-${g.key}`}>
              <h2 className={`rp-gh${g.late ? " rp-gh--late" : ""}`} id={`rp-g-${g.key}`}>{g.label}<span className="rp-gh__n">{g.rows.length}</span></h2>
              {g.rows.length ? null : <p className="rp-empty">{g.empty}</p>}
              {shown.map((row) => <ListRow key={row.id} row={row} href={`${hrefBase}${sep}item=${encodeURIComponent(row.id)}`} />)}
              {g.rows.length > SHOW_LIMIT ? (
                <button type="button" className="rp-more" aria-expanded={open} onClick={() => r?.toggle(g.key)}>
                  {open ? "Show less" : `Show ${g.rows.length - SHOW_LIMIT} more`}
                </button>
              ) : null}
            </section>
          );
        })}
        {groups.length === 0 ? <p className="rp-empty">Nothing here yet.</p> : null}
      </div>
    </>
  );
}

// ---------- detail header ----------

/** ↑ ↓ and "2 of 14". */
export function DetailNav({ id }: { id: string }) {
  const r = useReading();
  if (!r) return null;
  const at = r.visible.indexOf(id);
  const go = (d: 1 | -1) => { const to = step(r.visible, at < 0 ? null : id, d); if (to && to !== id) r.select(to); };
  return (
    <div className="rp-nav2">
      <button type="button" className="rp-ico" aria-label="Previous item (K)" onClick={() => go(-1)} disabled={at <= 0 && at !== -1}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 15 6-6 6 6" /></svg>
      </button>
      <button type="button" className="rp-ico" aria-label="Next item (J)" onClick={() => go(1)} disabled={at === r.visible.length - 1}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {at >= 0 ? <span className="rp-pos">{at + 1} of {r.visible.length}</span> : null}
    </div>
  );
}

/** Phones: back from the detail to the list. Hidden on wide screens. */
export function BackToList({ label = "Back" }: { label?: string }) {
  const r = useReading();
  if (!r) return null;
  return (
    <button type="button" className="rp-back rp-back--list" onClick={() => r.select(null)}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
      {label}
    </button>
  );
}

/** Mark done (or Reopen, or Not a decision): the solid CTA, also on E. */
export function DoneButton({ id, done, back: fallback }: { id: string; done: boolean; back: string }) {
  const r = useReading();
  const form = useRef<HTMLFormElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const fill = () => { if (field.current) field.current.value = r ? r.backFor(id, true, done ? undefined : "done") : fallback; };
  useRpAct((cmd) => { if (cmd === "done") { fill(); form.current?.requestSubmit(); } });
  return (
    <form action={setStatus} ref={form}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="status" value={done ? "open" : "done"} />
      <input type="hidden" name="back" defaultValue={fallback} ref={field} />
      <button type="submit" className="rp-cbtn rp-cbtn--pri" onClick={fill}>
        <span className="rp-tick"><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><path d="M2 6.5 5 9l5-6" /></svg></span>
        {done ? "Reopen" : "Mark done"}<span className="rp-kbd">E</span>
      </button>
    </form>
  );
}

/** A hidden "Not a promise" form the ⋯ menu and W submit. */
export function WrongForm({ id, back: fallback, label = "Not a promise" }: { id: string; back: string; label?: string }) {
  const r = useReading();
  const field = useRef<HTMLInputElement>(null);
  return (
    <form action={setStatus} className="rp-menu__form" data-rp-wrong="">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="status" value="wrong" />
      <input type="hidden" name="back" defaultValue={fallback} ref={field} />
      <button type="submit" role="menuitem" className="rp-menu__warn" onClick={() => { if (field.current) field.current.value = r ? r.backFor(id, true, "wrong") : fallback; }}>
        <span>{label}</span><span className="rp-kbd">W</span>
      </button>
    </form>
  );
}

/** The list header's + : quick capture, started with `text` (a person, a +project). */
export function AddButton({ text, label }: { text?: string; label?: string }) {
  const open = () => window.dispatchEvent(new CustomEvent<CaptureDetail>(OPEN_CAPTURE, { detail: text ? { text } : {} }));
  if (label) return <button type="button" className="rp-btn rp-btn--pri" onClick={open}>{label}</button>;
  return (
    <button type="button" className="rp-ico" aria-label="Add an item (C)" title="Add an item (C)" onClick={() => window.dispatchEvent(new CustomEvent<CaptureDetail>(OPEN_CAPTURE, { detail: text ? { text } : {} }))}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
    </button>
  );
}

/** A small popover under an icon button (the list's view options, the detail's ⋯). */
export function Popover({ label, icon, children, className = "", openOn }: { label: string; icon: ReactNode; children: ReactNode; className?: string; openOn?: KeyCommand }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useRpAct((cmd) => { if (openOn && cmd === openOn) setOpen((o) => !o); if (cmd === "close") setOpen(false); });
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", down);
    document.addEventListener("keydown", key);
    requestAnimationFrame(() => wrap.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus());
    return () => { document.removeEventListener("pointerdown", down); document.removeEventListener("keydown", key); };
  }, [open]);
  return (
    <div className={`rp-pop ${className}`} ref={wrap}>
      <button type="button" className="rp-ico" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{icon}</button>
      {open ? <div className="rp-menu" role="menu" onClick={(e) => { if ((e.target as HTMLElement).closest("a,[data-close]")) setOpen(false); }}>{children}</div> : null}
    </div>
  );
}
