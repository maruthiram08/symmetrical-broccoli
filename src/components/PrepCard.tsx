import Link from "next/link";
import type { Item } from "@/lib/types";
import type { Prep } from "@/lib/wow/prep";
import { Mark } from "./Mark";

const SHOWN = 5;

/** "Next: Design crit at 4:30 PM": what's open with the people you're about to meet. */
export function PrepCard({ prep, time, inLabel, nowMs }: { prep: Prep; time: string; inLabel: string; nowMs: number }) {
  const cap = (s: string | null) => (s ? s[0].toUpperCase() + s.slice(1) : "");
  const rows: Array<{ kind: "owe" | "waiting"; item: Item }> = [
    ...prep.owe.map((item) => ({ kind: "owe" as const, item })),
    ...prep.waiting.map((item) => ({ kind: "waiting" as const, item })),
  ];
  return (
    <section className="pc" aria-labelledby="pc-title">
      <div className="pc__head">
        <h2 id="pc-title" className="pc__title">Next: {prep.meeting.title} <span className="pc__at">at <span className="db-mono">{time}</span></span></h2>
        <span className="pc__in db-mono">{inLabel}</span>
      </div>
      {prep.people.length ? <p className="pc__people">With {prep.people.join(", ")}</p> : null}
      {rows.length ? (
        <ul className="pc__list">
          {rows.slice(0, SHOWN).map(({ kind, item }) => (
            <li key={item.id} className={`pc__row pc__row--${kind}`}>
              <Mark kind={item.dueAt && Date.parse(item.dueAt) < nowMs ? "overdue" : kind} />
              <span className="pc__text">{item.text}</span>
              <span className="pc__kind">{kind === "owe" ? `you owe ${cap(item.person)}` : `${cap(item.person)} owes you`}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {rows.length > SHOWN ? <p className="pc__none">and {rows.length - SHOWN} more with them, on <Link className="db-link" href="/people">People</Link>.</p> : null}
      {rows.length ? null : (
        <p className="pc__none">Nothing open with {prep.people.length ? "them" : "anyone in this meeting"}.</p>
      )}
    </section>
  );
}
