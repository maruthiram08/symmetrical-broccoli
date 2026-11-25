"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ItemKind } from "@/lib/types";

interface Props {
  quote: string;
  kind: ItemKind;
  speaker: string | null;
  meetingTitle: string;
  when: string;
  /** A real Wispr Flow URL from stored data, or null (then no link is shown). */
  link: string | null;
}

const OPEN_DELAY = 180;
const CLOSE_DELAY = 140;

/**
 * The item's quote, which opens a small card with the exact words, who said them, and the meeting.
 * Opens on hover, on keyboard focus and on tap; Esc or a tap elsewhere closes it.
 */
export function QuotePeek({ quote, kind, speaker, meetingTitle, when, link }: Props) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const id = useId();
  const wrap = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const later = useCallback((fn: () => void, ms: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(fn, ms);
  }, []);
  const close = useCallback(() => { setOpen(false); setPinned(false); }, []);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      const inside = wrap.current?.contains(document.activeElement);
      close();
      if (inside) trigger.current?.focus();
    };
    const onDown = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) close(); };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("pointerdown", onDown); };
  }, [open, close]);

  return (
    <span
      ref={wrap}
      className="qp"
      onPointerEnter={(e) => { if (e.pointerType === "mouse" && !pinned) later(() => setOpen(true), OPEN_DELAY); }}
      onPointerLeave={(e) => { if (e.pointerType === "mouse" && !pinned) later(() => setOpen(false), CLOSE_DELAY); }}
      onBlur={(e) => { if (!wrap.current?.contains(e.relatedTarget as Node | null)) close(); }}
    >
      <button
        ref={trigger}
        type="button"
        className="qp__trigger db-item__quote"
        aria-expanded={open}
        aria-controls={id}
        aria-haspopup="dialog"
        onFocus={(e) => { if (e.currentTarget.matches(":focus-visible")) setOpen(true); }}
        onClick={() => {
          if (timer.current) clearTimeout(timer.current);
          if (open && pinned) close();
          else { setOpen(true); setPinned(true); }
        }}
      >
        &ldquo;{quote}&rdquo;
      </button>
      {open ? (
        <span id={id} role="dialog" aria-label="Quote from the meeting" className={`qp__card qp__card--${kind}`}>
          <span className="qp__quote">&ldquo;{quote}&rdquo;</span>
          <span className="qp__meta">
            {speaker ? <span className="qp__speaker">{speaker}</span> : null}
            <span className="qp__title">{meetingTitle}</span>
            {when ? <span className="qp__when">{when}</span> : null}
          </span>
          {link ? (
            <a className="qp__link" href={link} target="_blank" rel="noreferrer noopener">Open in Wispr Flow <span aria-hidden="true">↗</span></a>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}
