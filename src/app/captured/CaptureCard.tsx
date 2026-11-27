"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { deleteItemAction, switchKindAction } from "../capture-actions";

interface CardItem {
  id: string;
  kind: "owe" | "waiting";
  text: string;
  person: string | null;
  inbox: boolean;
  project: string | null;
  slack: boolean;
  due: boolean;
}

/** How long the card stays when you leave it alone, and after the pointer leaves it. */
const STAY_MS = 7000;
const AFTER_HOVER_MS = 2500;

/** The Mac app closes the card when the page goes here (src-tauri/src/main.rs, show_toast). */
const close = () => { window.location.href = "/captured/close"; };

export function CaptureCard({ item, error }: { item?: CardItem; error?: { title: string; detail: string } }) {
  const [kind, setKind] = useState(item?.kind ?? "owe");
  const [undone, setUndone] = useState(false);
  const [pending, start] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const arm = (ms: number) => { if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(close, ms); };
  const hold = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };

  useEffect(() => {
    arm(error ? 4500 : STAY_MS);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => { hold(); window.removeEventListener("keydown", onKey); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error || !item) {
    return (
      <main className="cc" onMouseEnter={hold} onMouseLeave={() => arm(AFTER_HOVER_MS)}>
        <div className="cc__top"><span className="cc__dot cc__dot--warn" aria-hidden="true" /><b>{error?.title}</b><button className="cc__x" onClick={close} aria-label="Close">×</button></div>
        <p className="cc__detail">{error?.detail}</p>
      </main>
    );
  }

  const where = item.inbox ? "Inbox" : kind === "waiting" ? `Waiting on ${item.person ?? "someone"}` : item.person ? `You owe ${item.person}` : "You owe";
  const undo = () => start(async () => { const r = await deleteItemAction(item.id); if (r.ok) { setUndone(true); arm(1500); } });
  const flip = () => start(async () => { const r = await switchKindAction(item.id); if (r.ok) setKind((k) => (k === "owe" ? "waiting" : "owe")); arm(STAY_MS); });

  if (undone) {
    return (
      <main className="cc cc--done">
        <div className="cc__top"><span className="cc__dot" aria-hidden="true" /><b>Removed</b><button className="cc__x" onClick={close} aria-label="Close">×</button></div>
        <p className="cc__detail">Nothing was added.</p>
      </main>
    );
  }

  return (
    <main className="cc" onMouseEnter={hold} onMouseLeave={() => arm(AFTER_HOVER_MS)}>
      <div className="cc__top">
        <span className={`cc__mark cc__mark--${kind}`} aria-hidden="true" />
        <b>Added to {where}</b>
        <span className="cc__src">{item.slack ? "from Slack" : "from clipboard"}</span>
        <button className="cc__x" onClick={close} aria-label="Close">×</button>
      </div>
      <p className="cc__text" title={item.text}>{item.text}</p>
      <div className="cc__meta">{[item.project ? `Filed in ${item.project}` : "Needs a project", item.due ? "date found" : null].filter(Boolean).join(" · ")}</div>
      <div className="cc__acts">
        <button onClick={undo} disabled={pending}>Undo</button>
        {item.person && !item.inbox ? <button onClick={flip} disabled={pending}>{kind === "owe" ? `I'm waiting on ${first(item.person)}` : `I owe ${first(item.person)}`}</button> : null}
        <a className="cc__open" href={`/item/${encodeURIComponent(item.id)}`}>Open</a>
      </div>
    </main>
  );
}

const first = (name: string) => name.trim().split(/\s+/)[0];
