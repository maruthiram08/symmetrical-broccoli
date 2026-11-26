"use client";

// "Send to Jira / Linear / Notion / Todoist" on an item. In the item's actions it is one button (or a
// small menu when several are on); in the Start this panel it is a row of buttons. Nothing is sent
// until you click, and an item gets one ticket.
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { sendToTicketAction } from "@/app/integrations-actions";
import type { TicketProvider } from "@/lib/types";

type P = { id: TicketProvider; label: string };

function useSend(itemId: string) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ key: string; url: string; assignee: string | null } | null>(null);
  const send = (p: TicketProvider, after?: () => void) => {
    setError(null);
    start(async () => {
      const r = await sendToTicketAction(itemId, p);
      if (!r.ok) { setError(r.error); return; }
      setMade({ key: r.key, url: r.url, assignee: r.assignee });
      after?.();
      router.refresh();
    });
  };
  return { pending, error, made, send };
}

function Made({ made }: { made: { key: string; url: string; assignee: string | null } }) {
  return (
    <a className="int-ticket" href={made.url} target="_blank" rel="noopener noreferrer" role="status">
      Ticket: <span className="int-ticket__key">{made.key}</span>{made.assignee ? ` · ${made.assignee}` : ""}
    </a>
  );
}

export function SendToMenu({ itemId, providers }: { itemId: string; providers: P[] }) {
  const { pending, error, made, send } = useSend(itemId);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => menu.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus());
    const onDown = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  if (made) return <Made made={made} />;
  const one = providers.length === 1 ? providers[0] : null;
  return (
    <span className="db-snooze int-send" ref={wrap}>
      {one ? (
        <button type="button" className="db-act" disabled={pending} onClick={() => send(one.id)}>
          {pending ? "Sending…" : `Send to ${one.label}`}
        </button>
      ) : (
        <button type="button" className="db-act" aria-haspopup="menu" aria-expanded={open} aria-controls={id} disabled={pending} onClick={() => setOpen((o) => !o)}>
          {pending ? "Sending…" : "Send to…"}
        </button>
      )}
      {open && !one ? (
        <div
          className="db-snooze__menu"
          role="menu"
          id={id}
          ref={menu}
          aria-label="Send to"
          data-menu-open="true"
          onKeyDown={(e) => {
            const items = [...(menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
            const at = items.indexOf(document.activeElement as HTMLElement);
            if (e.key === "Escape") setOpen(false);
            else if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); items[(at + 1) % items.length]?.focus(); }
            else if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); items[(at - 1 + items.length) % items.length]?.focus(); }
            e.stopPropagation();
          }}
        >
          {providers.map((p) => (
            <button key={p.id} type="button" role="menuitem" disabled={pending} onClick={() => send(p.id, () => setOpen(false))}>
              {p.label}
            </button>
          ))}
        </div>
      ) : null}
      {error ? <span className="int-send__error" role="alert">{error}</span> : null}
    </span>
  );
}

/** The row in the Start this panel and on the item page. */
export function SendToRow({ itemId, providers }: { itemId: string; providers: P[] }) {
  const { pending, error, made, send } = useSend(itemId);
  if (made) return <p className="int-row"><Made made={made} /></p>;
  return (
    <div className="int-row">
      <span className="int-row__label">Or make it a ticket</span>
      {providers.map((p) => (
        <button key={p.id} type="button" className="db-handoff__btn" disabled={pending} onClick={() => send(p.id)}>
          Send to {p.label}
        </button>
      ))}
      {pending ? <span className="int-row__note" aria-live="polite">Sending…</span> : null}
      {error ? <span className="int-send__error" role="alert">{error}</span> : null}
    </div>
  );
}
