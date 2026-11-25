"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";

interface CardItem { id: string; text: string; late: boolean }
interface Card {
  name: string;
  slug: string;
  youOwe: CardItem[];
  youOweCount: number;
  theyOwe: CardItem[];
  theyOweCount: number;
  lastMeeting: { title: string; date: string } | null;
}

const OPEN_DELAY = 260;
const CLOSE_DELAY = 160;
/** One fetch per person per page view; cleared after a minute so Done/Wrong show up. */
const cache = new Map<string, { at: number; card: Promise<Card | null> }>();

function load(slug: string): Promise<Card | null> {
  const hit = cache.get(slug);
  if (hit && Date.now() - hit.at < 60_000) return hit.card;
  const card = fetch(`/api/person/${encodeURIComponent(slug)}`, { cache: "no-store" })
    .then((r) => (r.ok ? (r.json() as Promise<Card>) : null))
    .catch(() => null);
  cache.set(slug, { at: Date.now(), card });
  return card;
}

/**
 * A person's name, linked to their page. Hovering or focusing it opens a small card: what you owe
 * them, what they owe you, and when you last met. Esc closes it.
 */
export function PersonPeek({ slug, children, className = "db-plink" }: { slug: string; children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  const [card, setCard] = useState<Card | null | undefined>(undefined);
  const id = useId();
  const wrap = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const href = `/people/${encodeURIComponent(slug)}`;

  const later = useCallback((fn: () => void, ms: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(fn, ms);
  }, []);
  const show = useCallback(() => {
    setOpen(true);
    void load(slug).then(setCard);
  }, [slug]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const n = (k: number) => (k === 1 ? "1 thing" : `${k} things`);
  return (
    <span
      ref={wrap}
      className="w3-pp"
      onPointerEnter={(e) => { if (e.pointerType === "mouse") later(show, OPEN_DELAY); }}
      onPointerLeave={(e) => { if (e.pointerType === "mouse") later(() => setOpen(false), CLOSE_DELAY); }}
      onBlur={(e) => { if (!wrap.current?.contains(e.relatedTarget as Node | null)) setOpen(false); }}
    >
      <Link
        className={className}
        href={href}
        aria-describedby={open ? id : undefined}
        onFocus={(e) => { if (e.currentTarget.matches(":focus-visible")) show(); }}
      >
        {children}
      </Link>
      {open && card !== null ? (
        <span id={id} role="tooltip" className="w3-pp__card">
          {card === undefined ? (
            <span className="w3-pp__loading">Loading…</span>
          ) : (
            <>
              <span className="w3-pp__head">
                <span className="w3-pp__name">{card.name}</span>
                {card.lastMeeting ? (
                  <span className="w3-pp__last">Last met <span className="w3-mono">{card.lastMeeting.date}</span> · {card.lastMeeting.title}</span>
                ) : null}
              </span>
              <span className="w3-pp__group">
                <span className="w3-pp__label">You owe {card.youOweCount ? n(card.youOweCount) : "nothing"}</span>
                {card.youOwe.map((i) => (
                  <span key={i.id} className="w3-pp__row">
                    <span className={`db-mark db-mark--${i.late ? "overdue" : "owe"}`} aria-hidden="true" />
                    <span className="w3-pp__text">{i.text}</span>
                  </span>
                ))}
              </span>
              <span className="w3-pp__group">
                <span className="w3-pp__label">{card.theyOweCount ? `Owes you ${n(card.theyOweCount)}` : "Owes you nothing"}</span>
                {card.theyOwe.map((i) => (
                  <span key={i.id} className="w3-pp__row">
                    <span className={`db-mark db-mark--${i.late ? "overdue" : "waiting"}`} aria-hidden="true" />
                    <span className="w3-pp__text">{i.text}</span>
                  </span>
                ))}
              </span>
              <Link className="w3-pill" href={href} tabIndex={-1}>Open {card.name}&apos;s page <span aria-hidden="true">→</span></Link>
            </>
          )}
        </span>
      ) : null}
    </span>
  );
}
