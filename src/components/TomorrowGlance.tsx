import Link from "next/link";
import { alsoLabel } from "@/lib/calendar/glance";
import type { GlanceItem, GlanceMeeting } from "@/lib/types";
import { Mark } from "./Mark";

const cap = (s: string | null) => (s ? s[0].toUpperCase() + s.slice(1) : "");

function Row({ g, kind }: { g: GlanceItem; kind: "owe" | "waiting" }) {
  return (
    <li className={`cal-glance__row cal-glance__row--${kind}`}>
      <Mark kind={g.late ? "overdue" : kind} />
      <span className="cal-glance__text">{g.text}</span>
      <span className="cal-glance__kind">
        {kind === "owe" ? `you owe ${cap(g.person)}` : `${cap(g.person)} owes you`}
        {g.when ? <span className={g.late ? "cal-glance__late" : "cal-glance__when"}> · {g.when}</span> : null}
      </span>
    </li>
  );
}

/** Wrap's "Tomorrow at a glance": each of tomorrow's meetings and what's open with its people. */
export function TomorrowGlance({ meetings }: { meetings: GlanceMeeting[] | undefined }) {
  if (!meetings?.length) return null;
  return (
    <section className="db-section cal-glance" aria-labelledby="cal-glance-title">
      <div className="db-section__head">
        <h2 id="cal-glance-title" className="db-section__title">Tomorrow at a glance</h2>
        {meetings.length ? <span className="db-section__count">{meetings.length}</span> : null}
      </div>
      {meetings.length ? (
        <ol className="cal-glance__list">
          {meetings.map((m) => (
            <li key={`${m.calendarId}@${m.startsAt}`} className="cal-glance__meeting">
              <div className="cal-glance__head">
                <span className="cal-glance__time db-mono">{m.time}</span>
                <span className="cal-glance__title">
                  {m.seriesId ? <Link className="db-plink" href={`/series/${m.seriesId}`}>{m.title}</Link> : m.title}
                </span>
              </div>
              {m.people.length ? <p className="cal-glance__people">With {m.people.join(", ")}</p> : null}
              {m.owe.length || m.waiting.length ? (
                <ul className="cal-glance__items">
                  {m.owe.map((g) => <Row key={g.itemId} g={g} kind="owe" />)}
                  {m.waiting.map((g) => <Row key={g.itemId} g={g} kind="waiting" />)}
                </ul>
              ) : m.alsoOpen ? null : (
                <p className="cal-glance__none">Nothing open with them.</p>
              )}
              {m.alsoOpen ? <p className="cal-glance__none">{alsoLabel(m)}.</p> : null}
            </li>
          ))}
        </ol>
      ) : (
        <p className="db-section__empty">No meetings tomorrow.</p>
      )}
    </section>
  );
}
