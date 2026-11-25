import type { BriefLine, ClosedLine } from "@/lib/types";
import { setStatus } from "@/app/actions";
import { Mark } from "./Mark";
import { HandoffSlot } from "./HandoffSlot";
import { StartThisButton } from "./StartThis";

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
  const text = line.person && line.kind === "owe" && line.text.includes(line.person)
    ? withBold(line.text, line.person)
    : line.text;
  return (
    <div className={`db-item db-item--${line.kind}`}>
      <span className="db-item__icon"><Mark kind={mark} /></span>
      <span className="db-item__text">{text}</span>
      <span className="db-item__side">
        {late ? <span className="db-item__late">{line.lateLabel}</span> : line.dueLabel ? <span className="db-item__time">{line.dueLabel}</span> : null}
      </span>
      <span className="db-item__meta">
        <span className="db-item__quote">&ldquo;{line.quote}&rdquo;</span>
        <span className="db-item__src">· {line.meetingTitle}{line.meetingTime ? `, ${line.meetingTime}` : ""}</span>
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

function withBold(text: string, person: string) {
  const i = text.indexOf(person);
  return (
    <>
      {text.slice(0, i)}
      <b>{person}</b>
      {text.slice(i + person.length)}
    </>
  );
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
