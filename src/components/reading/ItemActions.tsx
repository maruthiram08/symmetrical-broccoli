"use client";

// The detail pane's actions: Snooze and Block 30 min beside Mark done, the "Get it done" rows
// (Start this hand-offs and tickets), and the ⋯ menu. Each also answers its key (see Pane.tsx).
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { setStarAction } from "@/app/capture-actions";
import { moveItemsToProjectAction, projectsAction } from "@/app/structure-actions";
import { sendToTicketAction } from "@/app/integrations-actions";
import type { TicketProvider } from "@/lib/types";
import { SnoozeMenu } from "../ItemTools";
import { openHandoff } from "../StartThis";
import { Popover, useRpAct, WrongForm } from "./Pane";

const ICON = {
  clock: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2.5 2.5M9 2h6" /></svg>,
  cal: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="2" /><path d="M3.5 10h17M8 3v4M16 3v4" /></svg>,
  chev: <svg className="rp-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>,
  msg: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M4 5h16v11H8l-4 4z" /></svg>,
  spark: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z" /></svg>,
  list: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" /></svg>,
  go: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>,
  dots: <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>,
};

/** Snooze, as an outlined pill with a dropdown. S opens it. */
export function SnoozeCta({ id, snoozedUntil }: { id: string; snoozedUntil: string | null }) {
  const wrap = useRef<HTMLSpanElement>(null);
  useRpAct((cmd) => { if (cmd === "snooze") wrap.current?.querySelector<HTMLButtonElement>("button")?.click(); });
  return (
    <span className="rp-snooze" ref={wrap}>
      <SnoozeMenu itemId={id} snoozedUntil={snoozedUntil} className="rp-cbtn" icon={ICON.clock} />
    </span>
  );
}

/** Block 30 min: the calendar file for the next free half hour. B. */
export function BlockCta({ id }: { id: string }) {
  const a = useRef<HTMLAnchorElement>(null);
  useRpAct((cmd) => { if (cmd === "block") a.current?.click(); });
  return (
    <a ref={a} className="rp-cbtn" href={`/api/block?id=${encodeURIComponent(id)}`} download title="A calendar file for the next free 30 minutes (B)">
      {ICON.cal}Block 30 min
    </a>
  );
}

type Ticket = { key: string; url: string; label: string } | null;

function HoRow({ icon, title, sub, rec, onClick, href, tag }: { icon: ReactNode; title: string; sub: string; rec?: boolean; onClick?: () => void; href?: string; tag?: string }) {
  const body = (
    <>
      <span className="rp-ho__hi">{icon}</span>
      <b>{title}</b>
      {tag ? <span className="rp-ho__tag">{tag}</span> : null}
      <span className="rp-ho__go">{ICON.go}</span>
      <span className="rp-ho__s">{sub}</span>
    </>
  );
  const cls = `rp-ho${rec ? " rp-ho--rec" : ""}`;
  if (href) return <a className={cls} href={href} target={href.startsWith("http") ? "_blank" : undefined} rel="noopener noreferrer">{body}</a>;
  return <button type="button" className={cls} onClick={onClick}>{body}</button>;
}

/**
 * "Get it done": Message the person and Hand to Claude open the Start this panel on that tab;
 * Make it a ticket sends to a service you set up, links the ticket made, or says where to set one up.
 */
export function GetItDone({ id, kind, person, ticket, providers }: { id: string; kind: "owe" | "waiting"; person: string | null; ticket: Ticket; providers: Array<{ id: TicketProvider; label: string }> }) {
  const router = useRouter();
  const [pickTicket, setPickTicket] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<Ticket>(null);
  const open = (tab: "slack" | "claude") => {
    openHandoff(id, tab);
    requestAnimationFrame(() => document.getElementById(`db-handoff-${id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  };
  useRpAct((cmd) => { if (cmd === "start") open("slack"); });
  const send = (p: TicketProvider) => {
    setError(null);
    start(async () => {
      const r = await sendToTicketAction(id, p);
      if (!r.ok) { setError(r.error); return; }
      setMade({ key: r.key, url: r.url, label: providers.find((x) => x.id === p)?.label ?? "" });
      setPickTicket(false);
      router.refresh();
    });
  };
  const t = made ?? ticket;
  const first = person?.split(/\s+/)[0] ?? null;
  return (
    <div className="rp-handoff">
      {first ? (
        <HoRow rec icon={ICON.msg} title={kind === "waiting" ? `Nudge ${first}` : `Message ${first}`} sub={kind === "waiting" ? "Drafts a Slack nudge or email from the quote" : "Drafts a Slack note or email from the quote"} tag="Suggested" onClick={() => open("slack")} />
      ) : null}
      <HoRow rec={!first} tag={first ? undefined : "Suggested"} icon={ICON.spark} title="Hand to Claude" sub="Starts a draft with this quote and meeting" onClick={() => open("claude")} />
      {t ? (
        <HoRow icon={ICON.list} title={`Ticket ${t.key}`} sub={`Open it${t.label ? ` in ${t.label}` : ""}`} href={t.url} />
      ) : providers.length ? (
        <>
          <HoRow
            icon={ICON.list}
            title={pending ? "Sending…" : "Make it a ticket"}
            sub={`${providers.map((p) => p.label).join(", ")}, with the quote attached`}
            onClick={() => (providers.length === 1 ? send(providers[0].id) : setPickTicket((o) => !o))}
          />
          {pickTicket ? (
            <div className="rp-ho__pick" role="group" aria-label="Send to">
              {providers.map((p) => <button key={p.id} type="button" className="rp-btn" disabled={pending} onClick={() => send(p.id)}>Send to {p.label}</button>)}
            </div>
          ) : null}
          {error ? <p className="rp-ho__err" role="alert">{error}</p> : null}
        </>
      ) : (
        <HoRow icon={ICON.list} title="Make it a ticket" sub="Set up Jira, Linear, Notion or Todoist in Settings first" href="/setup#integrations" tag="Set up" />
      )}
    </div>
  );
}

async function copy(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

/** The ⋯ menu: Start this, Move to project, Star, Copy quote, Open full page, Not a promise. */
export function ItemMenu({ id, quote, starred, actionable, manual, back, fullHref, project: project_ = null }: { id: string; quote: string; starred: boolean; actionable: boolean; manual: boolean; back: string; fullHref?: string; project?: string | null }) {
  const router = useRouter();
  const [flash, setFlash] = useState<string | null>(null);
  const [, start] = useTransition();
  const star = () => start(async () => { await setStarAction(id, !starred); router.refresh(); });
  const copyQuote = async () => { const ok = await copy(quote); setFlash(ok ? "Quote copied" : "Couldn't copy"); setTimeout(() => setFlash(null), 1800); };
  const [picking, setPicking] = useState(false);
  const project = () => setPicking(true);
  const startThis = () => { openHandoff(id, "slack"); document.getElementById(`db-handoff-${id}`)?.scrollIntoView({ block: "nearest" }); };
  const wrong = () => document.querySelector<HTMLButtonElement>("[data-rp-wrong-key] button")?.click();
  useRpAct((cmd) => {
    if (cmd === "star" && actionable) star();
    else if (cmd === "copy" && quote) void copyQuote();
    else if (cmd === "project" && actionable) project();
    else if (cmd === "wrong" && !manual) wrong();
  });
  return (
    <>
      {flash ? <span className="rp-flash" role="status">{flash}</span> : null}
      <Popover label="More actions (.)" icon={ICON.dots} openOn="menu" className="rp-pop--right">
        {actionable ? <button type="button" role="menuitem" data-close="" onClick={startThis}><span>Start this</span><span className="rp-kbd">T</span></button> : null}
        {actionable ? <button type="button" role="menuitem" data-close="" onClick={project}><span>Move to project…</span><span className="rp-kbd">P</span></button> : null}
        {actionable ? <button type="button" role="menuitem" data-close="" onClick={star}><span>{starred ? "Unstar" : "Star"}</span><span className="rp-kbd">F</span></button> : null}
        {quote ? <button type="button" role="menuitem" data-close="" onClick={() => void copyQuote()}><span>Copy quote</span><span className="rp-kbd">⇧C</span></button> : null}
        {fullHref ? <a role="menuitem" href={fullHref}><span>Open full page</span></a> : null}
        {manual ? null : <><hr /><WrongForm id={id} back={back} label={actionable ? "Not a promise" : "Not a decision"} /></>}
      </Popover>
      {manual ? null : <div hidden data-rp-wrong-key=""><WrongForm id={id} back={back} /></div>}
      {picking ? <ProjectPicker id={id} current={project_} onDone={(note) => { setPicking(false); if (note) { setFlash(note); setTimeout(() => setFlash(null), 2200); } }} /> : null}
    </>
  );
}

/** Move to project (P): every project, or none. Moves through the same action as Projects' bulk move. */
function ProjectPicker({ id, current, onDone }: { id: string; current: string | null; onDone: (note?: string) => void }) {
  const router = useRouter();
  const [list, setList] = useState<Array<{ slug: string; title: string }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => { void projectsAction().then(setList).catch(() => setError("Couldn't load projects.")); }, []);
  useEffect(() => { if (list) requestAnimationFrame(() => wrap.current?.querySelector<HTMLElement>("[role=menuitemradio],[role=menuitem]")?.focus()); }, [list]);
  useEffect(() => {
    const down = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) onDone(); };
    document.addEventListener("pointerdown", down);
    return () => document.removeEventListener("pointerdown", down);
  }, [onDone]);
  const move = (slug: string, title: string) => start(async () => {
    setError(null);
    const r = await moveItemsToProjectAction([id], slug);
    if (!r.ok) { setError(r.error); return; }
    onDone(slug ? `Moved to ${title}` : "Taken out of its project");
    router.refresh();
  });
  return (
    <div className="rp-menu rp-menu--picker" role="menu" aria-label="Move to project" ref={wrap} data-menu-open="true"
      onKeyDown={(e) => {
        const all = [...(wrap.current?.querySelectorAll<HTMLElement>("[role^=menuitem]") ?? [])];
        const at = all.indexOf(document.activeElement as HTMLElement);
        if (e.key === "Escape") onDone();
        else if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); all[(at + 1) % all.length]?.focus(); }
        else if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); all[(at - 1 + all.length) % all.length]?.focus(); }
        e.stopPropagation();
      }}>
      <div className="rp-menu__head">Move to project</div>
      {list === null && !error ? <span className="rp-menu__note">…</span> : null}
      {list?.length === 0 ? <span className="rp-menu__note">No projects yet. Make one on Projects.</span> : null}
      {(list ?? []).map((p) => (
        <button key={p.slug} type="button" role="menuitemradio" aria-checked={p.slug === current} disabled={pending} onClick={() => move(p.slug, p.title)}>
          <span>{p.title}</span>{p.slug === current ? <span>✓</span> : null}
        </button>
      ))}
      {current ? <><hr /><button type="button" role="menuitem" disabled={pending} onClick={() => move("", "")}><span>No project</span></button></> : null}
      {error ? <span className="rp-menu__note rp-late" role="alert">{error}</span> : null}
    </div>
  );
}
