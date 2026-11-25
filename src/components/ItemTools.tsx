"use client";

// Star, snooze and (for items you added) edit, next to Done/Wrong on every item.
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { setStarAction, snoozeAction, snoozeDatesAction } from "@/app/capture-actions";
import { OPEN_CAPTURE, type CaptureDetail } from "./QuickCapture";

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function short(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}
type Dates = { today: string; tomorrow: string; monday: string; week: string };

/** The star you can click, shown on the line itself while an item is starred. */
export function StarToggle({ itemId, starred }: { itemId: string; starred: boolean }) {
  const router = useRouter();
  const [on, setOn] = useState(starred);
  const [pending, start] = useTransition();
  useEffect(() => setOn(starred), [starred]);
  return (
    <button
      type="button"
      className={`db-star${on ? " db-star--on" : ""}`}
      aria-pressed={on}
      aria-label={on ? "Unstar" : "Star: pin to the top"}
      title={on ? "Starred (s)" : "Star (s)"}
      data-key-act="star"
      disabled={pending}
      onClick={() => {
        const next = !on;
        setOn(next);
        start(async () => { await setStarAction(itemId, next); router.refresh(); });
      }}
    >
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path d="M8 1.6l1.9 4 4.4.5-3.3 3 .9 4.3L8 11.2l-3.9 2.2.9-4.3-3.3-3 4.4-.5z" />
      </svg>
    </button>
  );
}

export function SnoozeMenu({ itemId, snoozedUntil }: { itemId: string; snoozedUntil?: string | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const wrap = useRef<HTMLSpanElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const [dates, setDates] = useState<Dates | null>(null);

  // Dates come from the server, in your zone.
  useEffect(() => {
    if (!open) return;
    void snoozeDatesAction().then(setDates).catch(() => setError("Couldn't load dates."));
  }, [open]);
  useEffect(() => {
    if (!open || !dates) return;
    requestAnimationFrame(() => menu.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus());
  }, [open, dates]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const snooze = (until: string | null) => {
    setError(null);
    start(async () => {
      const r = await snoozeAction(itemId, until);
      if (!r.ok) { setError(r.error); return; }
      setOpen(false);
      router.refresh();
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOpen(false); trigger.current?.focus(); }
    else if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); e.stopPropagation(); items[(at + 1) % items.length]?.focus(); }
    else if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); e.stopPropagation(); items[(at - 1 + items.length) % items.length]?.focus(); }
    else e.stopPropagation(); // keep item shortcuts out while the menu is open
  };

  return (
    <span className="db-snooze" ref={wrap}>
      <button
        ref={trigger}
        type="button"
        className="db-act"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        data-key-act="snooze"
        onClick={() => setOpen((o) => !o)}
      >
        {snoozedUntil ? `Till ${short(snoozedUntil)}` : "Snooze"}
      </button>
      {open ? (
        <div className="db-snooze__menu" role="menu" id={id} ref={menu} aria-label="Snooze until" onKeyDown={onKeyDown} data-menu-open="true">
          {dates ? <>
            <button type="button" role="menuitem" disabled={pending} onClick={() => snooze(dates.tomorrow)}>Tomorrow <span>{short(dates.tomorrow)}</span></button>
            {dates.monday !== dates.tomorrow ? <button type="button" role="menuitem" disabled={pending} onClick={() => snooze(dates.monday)}>Monday <span>{short(dates.monday)}</span></button> : null}
            <button type="button" role="menuitem" disabled={pending} onClick={() => snooze(dates.week)}>In a week <span>{short(dates.week)}</span></button>
            <label className="db-snooze__pick">
              <span>Pick a day</span>
              <input type="date" role="menuitem" min={dates.tomorrow} onChange={(e) => { if (e.target.value) snooze(e.target.value); }} />
            </label>
          </> : <span className="db-snooze__loading">…</span>}
          {snoozedUntil ? <button type="button" role="menuitem" disabled={pending} onClick={() => snooze(null)}>Bring back now</button> : null}
          {error ? <span className="db-snooze__error" role="alert">{error}</span> : null}
        </div>
      ) : null}
    </span>
  );
}

/** Opens quick capture on one of your own items. */
export function EditButton({ edit: { dueAt, ...edit } }: { edit: Omit<NonNullable<CaptureDetail["edit"]>, "dueDate"> & { dueAt: string | null } }) {
  // A first guess in this Mac's zone; quick capture settles it in your zone.
  const dueDate = dueAt ? ymd(new Date(dueAt)) : null;
  return (
    <button
      type="button"
      className="db-act"
      data-key-act="edit"
      onClick={() => window.dispatchEvent(new CustomEvent<CaptureDetail>(OPEN_CAPTURE, { detail: { edit: { ...edit, dueDate, dueAt } } }))}
    >
      Edit
    </button>
  );
}
