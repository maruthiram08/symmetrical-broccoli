"use client";

// A Kanban board: drag a card to another column (or use its Move menu, on a phone or keyboard)
// and onMove changes what the columns stand for: status, kind, project or a property.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export interface Card {
  id: string;
  title: string;
  href: string;
  /** Small line under the title. */
  sub?: string;
  /** db-mark kind: owe, waiting, decision, done, overdue. */
  mark?: string;
  tags?: string[];
}

const NONE = "__none";

export interface Column { key: string; label: string; cards: Card[] }

export function Kanban({ columns, onMove, label, movable = true }: {
  columns: Column[];
  onMove: (cardId: string, to: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  label: string;
  movable?: boolean;
}) {
  const router = useRouter();
  const [cols, setCols] = useState(columns);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, start] = useTransition();
  const [seen, setSeen] = useState(columns);
  if (seen !== columns) { setSeen(columns); setCols(columns); }

  const move = (cardId: string, to: string) => {
    const from = cols.find((c) => c.cards.some((x) => x.id === cardId));
    if (!from || from.key === to) return;
    const card = from.cards.find((x) => x.id === cardId)!;
    const before = cols;
    setCols(cols.map((c) => (c.key === from.key ? { ...c, cards: c.cards.filter((x) => x.id !== cardId) } : c.key === to ? { ...c, cards: [card, ...c.cards] } : c)));
    setError(null);
    start(async () => {
      const r = await onMove(cardId, to).catch(() => ({ ok: false as const, error: "Couldn't reach Daily brief." }));
      if (!r.ok) { setCols(before); setError(r.error); return; }
      router.refresh();
    });
  };

  return (
    <div className="st-kanban-wrap">
      {error ? <p className="st-error" role="alert">{error}</p> : null}
      <div className="st-kanban" role="list" aria-label={label}>
        {cols.map((c) => (
          <section
            key={c.key || "_none"}
            role="listitem"
            aria-label={`${c.label}, ${c.cards.length}`}
            className={`st-col${over === c.key && dragging ? " st-col--over" : ""}`}
            onDragOver={(e) => { if (movable && dragging) { e.preventDefault(); setOver(c.key); } }}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver((o) => (o === c.key ? null : o)); }}
            onDrop={(e) => { e.preventDefault(); const id = e.dataTransfer.getData("text/x-card") || dragging; setOver(null); setDragging(null); if (id) move(id, c.key); }}
          >
            <h3 className="st-col__head"><span>{c.label}</span><span className="st-col__n">{c.cards.length}</span></h3>
            <ul className="st-col__cards">
              {c.cards.map((card) => (
                <li
                  key={card.id}
                  className={`st-card${dragging === card.id ? " st-card--drag" : ""}`}
                  draggable={movable}
                  onDragStart={(e) => { e.dataTransfer.setData("text/x-card", card.id); e.dataTransfer.effectAllowed = "move"; setDragging(card.id); }}
                  onDragEnd={() => { setDragging(null); setOver(null); }}
                >
                  <span className="st-card__top">
                    {card.mark ? <span className={`db-mark db-mark--${card.mark}`} aria-hidden="true" /> : null}
                    <Link className="st-card__title" href={card.href} draggable={false}>{card.title}</Link>
                  </span>
                  {card.sub || card.tags?.length ? (
                    <span className="st-card__sub">
                      {card.sub ? <span>{card.sub}</span> : null}
                      {card.tags?.map((t) => <span key={t} className="st-tag st-tag--quiet">#{t}</span>)}
                    </span>
                  ) : null}
                  {movable ? (
                    <select className="st-card__move" aria-label={`Move “${card.title}” to`} value="" onChange={(e) => { if (e.target.value) move(card.id, e.target.value === NONE ? "" : e.target.value); }}>
                      <option value="">Move…</option>
                      {cols.filter((x) => x.key !== c.key).map((x) => <option key={x.key || NONE} value={x.key || NONE}>{x.label}</option>)}
                    </select>
                  ) : null}
                </li>
              ))}
              {!c.cards.length ? <li className="st-col__empty">{movable ? "Drop here" : "Nothing"}</li> : null}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
