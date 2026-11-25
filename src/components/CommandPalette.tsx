"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { checkMeetingsNow } from "@/app/actions";
import { fold, terms } from "@/lib/search";
import { Highlight } from "./Highlight";
import { SearchIcon } from "./SearchIcon";
import { OPEN_CAPTURE, type CaptureDetail } from "./QuickCapture";

interface Nav {
  people: Array<{ name: string; slug: string; youOwe: number; theyOwe: number }>;
  days: Array<{ date: string; label: string }>;
}
interface Result { type: "item" | "meeting"; id: string; kind: string; status: string; text: string; sub: string; href: string }

interface Row {
  id: string;
  group: string;
  label: string;
  sub?: string;
  mark?: string;
  keys?: string[];
  href?: string;
  run?: () => void;
  /** Highlight the label with the query (search results and filtered names). */
  hl?: boolean;
}

/** Opens the palette from anywhere (the "/" key falls back to this when there is no search field). */
export const OPEN_PALETTE = "db:palette";

const GO: Array<Omit<Row, "group">> = [
  { id: "go-today", label: "Today", href: "/", keys: ["G", "T"] },
  { id: "go-open", label: "All open", href: "/open", keys: ["G", "O"] },
  { id: "go-people", label: "People", href: "/people", keys: ["G", "P"] },
  { id: "go-settings", label: "Settings", href: "/setup" },
];

/** Every query word starts a word in the label. */
function matches(label: string, ws: string[]): boolean {
  const hay = fold(label);
  return ws.every((w) => hay.includes(" " + w));
}

/** ⌘K / Ctrl+K command palette: jump anywhere, check meetings, and search everything. */
export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [nav, setNav] = useState<Nav>({ people: [], days: [] });
  const [results, setResults] = useState<{ q: string; rows: Result[] }>({ q: "", rows: [] });
  const [, startTransition] = useTransition();
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const restore = useRef<HTMLElement | null>(null);

  const show = useCallback(() => {
    restore.current = document.activeElement as HTMLElement | null;
    setQ("");
    setSel(0);
    setOpen(true);
  }, []);
  const close = useCallback(() => {
    setOpen(false);
    restore.current?.focus?.();
  }, []);

  // ⌘K / Ctrl+K toggles; other components can ask it to open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (open) close(); else show();
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_PALETTE, show);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener(OPEN_PALETTE, show); };
  }, [open, show, close]);

  // People and days once per open; results on every keystroke, newest request wins.
  useEffect(() => {
    if (!open) return;
    const ctl = new AbortController();
    fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: ctl.signal })
      .then((r) => r.json())
      .then((d: Nav & { results: Result[] }) => {
        if (!q) setNav({ people: d.people, days: d.days });
        setResults({ q, rows: d.results });
      })
      .catch(() => {});
    return () => ctl.abort();
  }, [open, q]);

  useEffect(() => { if (open) input.current?.focus(); }, [open]);

  const go = useCallback((r: Row) => {
    close();
    if (r.run) r.run();
    else if (r.href) router.push(r.href);
  }, [close, router]);

  const rows = useMemo<Row[]>(() => {
    const ws = terms(q);
    const out: Row[] = [];
    const goRows = GO.filter((r) => !ws.length || matches(r.label, ws)).map((r) => ({ ...r, group: "Go to" }));
    const check: Row = { id: "act-check", group: "Actions", label: "Check meetings now", run: () => startTransition(() => { void checkMeetingsNow(); }) };
    const people = nav.people
      .filter((p) => !ws.length || matches(p.name, ws))
      .slice(0, ws.length ? 4 : 5)
      .map<Row>((p) => ({
        id: `p-${p.slug}`, group: "People", label: p.name, href: `/people/${encodeURIComponent(p.slug)}`, hl: true,
        sub: [p.youOwe ? `you owe ${p.youOwe}` : "", p.theyOwe ? `owes you ${p.theyOwe}` : ""].filter(Boolean).join(" · ") || undefined,
      }));
    const days = nav.days
      .filter((d) => !ws.length || matches(`${d.label} ${d.date}`, ws))
      .slice(0, ws.length ? 3 : 4)
      .map<Row>((d) => ({ id: `d-${d.date}`, group: "Earlier days", label: d.label, href: `/day/${d.date}`, hl: true }));
    // Add…: opens quick capture, with what you typed ("add send Nitin the deck" puts it first).
    const typed = q.trim().replace(/^add\b\s*/i, "");
    const addFirst = /^add\b/i.test(q.trim());
    const add: Row = {
      id: "act-add", group: "Actions", label: typed && ws.length ? `Add “${typed}”` : "Add…", keys: ["C"],
      run: () => window.dispatchEvent(new CustomEvent<CaptureDetail>(OPEN_CAPTURE, { detail: { text: typed && ws.length ? typed : "" } })),
    };
    if (addFirst) out.push(add);
    out.push(...goRows);
    if (!ws.length || matches(check.label, ws)) out.push(check);
    if (!ws.length) out.push(add);
    out.push(...people, ...days);
    if (ws.length) {
      for (const r of results.rows) {
        out.push({
          id: `r-${r.id}`, group: "Results", label: r.text, sub: r.sub, href: r.href, hl: true,
          mark: r.type === "meeting" ? "meeting" : r.status === "done" ? "done" : r.kind,
        });
      }
      out.push({ id: "search-all", group: "Results", label: `Search everything for “${q.trim()}”`, href: `/search?q=${encodeURIComponent(q.trim())}` });
      if (!addFirst) out.push({ ...add, group: "Add" });
    }
    return out;
  }, [q, nav, results]);

  useEffect(() => { setSel((s) => Math.min(s, Math.max(0, rows.length - 1))); }, [rows.length]);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [sel, open]);

  if (!open) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) { e.preventDefault(); setSel((s) => (s + 1) % rows.length); }
    else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) { e.preventDefault(); setSel((s) => (s - 1 + rows.length) % rows.length); }
    else if (e.key === "Home" && e.ctrlKey) { e.preventDefault(); setSel(0); }
    else if (e.key === "End" && e.ctrlKey) { e.preventDefault(); setSel(rows.length - 1); }
    else if (e.key === "Enter") { e.preventDefault(); if (rows[sel]) go(rows[sel]); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "Tab") { e.preventDefault(); input.current?.focus(); } // focus stays in the palette
  };

  const ws = terms(q);
  let last = "";
  return (
    <div className="db-palette-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="db-palette" role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={onKeyDown}>
        <div className="db-palette__input">
          <SearchIcon />
          <input
            ref={input}
            value={q}
            onChange={(e) => { setQ(e.target.value); setSel(0); }}
            placeholder="Jump to, or search everything"
            role="combobox"
            aria-expanded="true"
            aria-controls="db-palette-list"
            aria-activedescendant={rows[sel] ? `db-pal-${rows[sel].id}` : undefined}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
          />
          <span className="db-kbd">esc</span>
        </div>
        <div className="db-palette__list" id="db-palette-list" role="listbox" ref={list} aria-label="Commands">
          {rows.map((r, k) => {
            const head = r.group !== last ? r.group : null;
            last = r.group;
            return (
              <div key={r.id} role="presentation">
                {head ? <div className="db-palette__group" role="presentation">{head}</div> : null}
                <div
                  id={`db-pal-${r.id}`}
                  role="option"
                  aria-selected={k === sel}
                  className="db-palette__row"
                  onMouseMove={() => { if (k !== sel) setSel(k); }}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => go(r)}
                >
                  {r.mark ? <span className={`db-mark db-mark--${r.mark}`} aria-hidden="true" /> : <span className="db-palette__dot" aria-hidden="true" />}
                  <span className="db-palette__label">{r.hl ? <Highlight text={r.label} q={ws} /> : r.label}</span>
                  {r.sub ? <span className="db-palette__sub">{r.sub}</span> : null}
                  {r.keys ? <span className="db-palette__keys">{r.keys.map((x) => <span key={x} className="db-kbd">{x}</span>)}</span> : null}
                </div>
              </div>
            );
          })}
        </div>
        <div className="db-palette__foot">
          <span><span className="db-kbd">↑</span><span className="db-kbd">↓</span> move</span>
          <span><span className="db-kbd">↵</span> open</span>
          <span><span className="db-kbd">esc</span> close</span>
          <span className="db-palette__foot-end"><span className="db-kbd">/</span> search · <span className="db-kbd">G</span> then <span className="db-kbd">T</span> <span className="db-kbd">O</span> <span className="db-kbd">P</span></span>
        </div>
      </div>
    </div>
  );
}
