import type { BriefLine, ClosedLine } from "@/lib/types";
import Link from "next/link";
import { setStatus } from "@/app/actions";
import { personSlug } from "@/lib/people";
import { Mark } from "./Mark";
import { QuotePeek } from "./QuotePeek";
import { HandoffSlot } from "./HandoffSlot";
import { StartThisButton } from "./StartThis";
import { PersonPeek } from "./PersonPeek";

function Act({ id, status, label, back }: { id: string; status: "done" | "wrong" | "open"; label: string; back?: string }) {
  return (
    <form action={setStatus}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="status" value={status} />
      {back ? <input type="hidden" name="back" value={back} /> : null}
      <button className="db-act" type="submit">{label}</button>
    </form>
  );
}

export function BriefItem({ line, back }: { line: BriefLine; back?: string }) {
  const late = line.lateLabel !== null;
  const mark = late ? "overdue" : line.kind;
  const at = line.person ? line.text.toLowerCase().indexOf(line.person.toLowerCase()) : -1;
  const text = line.person && at >= 0
    ? withPerson(line.text, at, line.person.length, line.kind === "owe")
    : line.text;
  const personLink = line.person && at < 0 ? <PersonLink name={line.person} /> : null;
  return (
    <div className={`db-item db-item--${line.kind}`}>
      <span className="db-item__icon"><Mark kind={mark} /></span>
      <span className="db-item__text">{text}</span>
      <span className="db-item__side">
        {late ? <span className="db-item__late">{line.lateLabel}</span> : line.dueLabel ? <span className="db-item__time">{line.dueLabel}</span> : null}
      </span>
      <span className="db-item__meta">
        <QuotePeek
          quote={line.quote}
          kind={line.kind}
          speaker={line.peek?.speaker ?? null}
          meetingTitle={line.meetingTitle}
          when={line.peek?.when ?? line.meetingTime}
          link={line.peek?.link ?? null}
        />
        {personLink ? <span className="db-item__src">· {personLink}</span> : null}
        <span className="db-item__src">· {line.meetingTitle}{line.meetingTime ? `, ${line.meetingTime}` : ""}</span>
        <Link className="db-item__src w3-history" href={`/item/${encodeURIComponent(line.itemId)}`}>· History</Link>
      </span>
      <span className="db-item__acts">
        {line.kind !== "decision" ? <StartThisButton itemId={line.itemId} /> : null}
        {line.kind !== "decision" ? <Act id={line.itemId} status="done" label="Done" back={back} /> : null}
        <Act id={line.itemId} status="wrong" label="Wrong" back={back} />
      </span>
      {line.kind !== "decision" ? <HandoffSlot line={line} /> : null}
    </div>
  );
}

/** The person's name in the line, linked to their page (and bold on things you owe). */
function withPerson(text: string, i: number, len: number, bold: boolean) {
  const name = text.slice(i, i + len);
  return (
    <>
      {text.slice(0, i)}
      <PersonLink name={name}>{bold ? <b>{name}</b> : name}</PersonLink>
      {text.slice(i + len)}
    </>
  );
}

function PersonLink({ name, children }: { name: string; children?: React.ReactNode }) {
  const slug = personSlug(name);
  if (!slug) return <>{children ?? name}</>;
  return <PersonPeek slug={slug}>{children ?? name}</PersonPeek>;
}

export function ClosedItem({ line }: { line: ClosedLine }) {
  return (
    <div className="db-item db-item--done">
      <span className="db-item__icon"><Mark kind="done" /></span>
      <span className="db-item__text">{line.text}</span>
      <span className="db-item__side" />
      <span className="db-item__evidence">
        Closed: {line.person ? `${line.person} said ` : ""}&ldquo;{line.closeQuote}&rdquo; in {line.closedInMeeting}{line.closedAtTime ? `, ${line.closedAtTime}` : ""}.
      </span>
    </div>
  );
}

export function Section({ title, count, empty, children }: { title: string; count?: string; empty?: string; children?: React.ReactNode }) {
  const has = Array.isArray(children) ? children.length > 0 : !!children;
  return (
    <section className="db-section">
      <div className="db-section__head">
        <h2 className="db-section__title">{title}</h2>
        {count ? <span className="db-section__count">{count}</span> : null}
      </div>
      {has ? children : <p className="db-section__empty">{empty}</p>}
    </section>
  );
}
