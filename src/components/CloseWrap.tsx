import Link from "next/link";
import type { CloseMomentLine } from "@/lib/brief/looked";
import type { PersonCount, StaleItem, WeekDecision } from "@/lib/brief/week";
import type { WrapClose, WrapPromise } from "@/lib/brief/wrap";
import { ClosedItem, Section } from "./BriefList";
import { Mark } from "./Mark";

/** Links to the evening wrap and the week, under Today's title. */
export function SummaryLinks({ current }: { current?: "wrap" | "week" }) {
  return (
    <nav className="cw-links" aria-label="Summaries">
      <Link className="cw-pill" href="/" aria-current={current ? undefined : "page"}>Today</Link>
      <Link className="cw-pill" href="/wrap" aria-current={current === "wrap" ? "page" : undefined}>Wrap</Link>
      <Link className="cw-pill" href="/week" aria-current={current === "week" ? "page" : undefined}>This week</Link>
    </nav>
  );
}

/** "Closed since you last looked": items a later meeting closed, with the closing words. */
export function CloseMoment({ lines }: { lines: CloseMomentLine[] }) {
  if (!lines.length) return null;
  return (
    <div className="cw-moment">
      <Section title="Closed since you last looked" count={String(lines.length)}>
        {lines.map((l) => (
          <div key={l.itemId} className={l.fresh ? "cw-close cw-close--fresh" : "cw-close"}>
            <ClosedItem line={l} />
          </div>
        ))}
      </Section>
    </div>
  );
}

export function Stats({ items }: { items: Array<{ label: string; value: number; late?: boolean }> }) {
  return (
    <dl className="cw-stats">
      {items.map((s) => (
        <div key={s.label} className="cw-stat">
          <dt className="cw-stat__label">{s.label}</dt>
          <dd className={s.late && s.value ? "cw-stat__value cw-stat__value--late" : "cw-stat__value"}>{s.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function PromiseRow({ p }: { p: WrapPromise }) {
  const mark = p.state === "kept" ? "done" : p.state === "late" ? "overdue" : "owe";
  return (
    <div className={`db-item ${p.state === "kept" ? "db-item--done" : "db-item--owe"}`}>
      <span className="db-item__icon"><Mark kind={mark} /></span>
      <span className="db-item__text">{p.text}</span>
      <span className="db-item__side">
        {p.label ? <span className={p.state === "late" ? "db-item__late" : "db-item__time"}>{p.label}</span> : null}
      </span>
      <span className="db-item__meta">
        <span className="db-item__quote">&ldquo;{p.quote}&rdquo;</span>
        <span className="db-item__src">· {p.meetingTitle}, {p.meetingTime}</span>
      </span>
    </div>
  );
}

export function CloseRow({ c }: { c: WrapClose }) {
  if (c.closeQuote) {
    return <ClosedItem line={{ itemId: c.itemId, text: c.text, closeQuote: c.closeQuote, person: c.person, closedInMeeting: c.closedInMeeting ?? "a meeting", closedAtTime: c.closedAtTime }} />;
  }
  return (
    <div className="db-item db-item--done">
      <span className="db-item__icon"><Mark kind="done" /></span>
      <span className="db-item__text">{c.text}</span>
      <span className="db-item__side" />
      <span className="db-item__evidence">Marked done, {c.closedAtTime}.</span>
    </div>
  );
}

export function PersonRow({ p }: { p: PersonCount }) {
  const closed = p.total - p.open;
  return (
    <div className="cw-person">
      <span className="cw-person__name">{p.person}</span>
      <span className="cw-person__n">{[p.open ? `${p.open} open` : "", closed ? `${closed} closed` : ""].filter(Boolean).join(" · ")}</span>
    </div>
  );
}

export function DecisionRow({ d }: { d: WeekDecision }) {
  return (
    <div className="db-item db-item--decision">
      <span className="db-item__icon"><Mark kind="decision" /></span>
      <span className="db-item__text">{d.text}</span>
      <span className="db-item__side"><span className="db-item__time">{d.day}</span></span>
      <span className="db-item__meta">
        <span className="db-item__quote">&ldquo;{d.quote}&rdquo;</span>
        <span className="db-item__src">· {d.meetingTitle}, {d.time}</span>
      </span>
    </div>
  );
}

export function StaleRow({ s }: { s: StaleItem }) {
  return (
    <div className={`db-item db-item--${s.kind}`}>
      <span className="db-item__icon"><Mark kind={s.kind} /></span>
      <span className="db-item__text">{s.text}</span>
      <span className="db-item__side"><span className="db-item__time">{s.ageDays} days</span></span>
      <span className="db-item__meta">
        <span className="db-item__quote">&ldquo;{s.quote}&rdquo;</span>
        <span className="db-item__src">· {s.meetingTitle}, {s.day}</span>
      </span>
    </div>
  );
}
