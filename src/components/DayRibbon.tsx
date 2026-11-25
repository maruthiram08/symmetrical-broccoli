import Link from "next/link";
import type { Ribbon } from "@/lib/wow/ribbon";

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/** Today's meetings on one line. A dot per meeting, bigger for more items; lime when you owe something from it. */
export function DayRibbon({ ribbon, selected }: { ribbon: Ribbon; selected?: string }) {
  if (!ribbon.meetings.length) {
    return (
      <div className="rb rb--empty">
        <div className="rb__track" aria-hidden="true">{ribbon.now !== null ? <i className="rb__now" style={{ left: `${ribbon.now * 100}%` }} /> : null}</div>
        <p className="rb__empty">No meetings yet today. They show up here as Wispr Flow records them.</p>
      </div>
    );
  }
  return (
    <nav className="rb" aria-label="Today's meetings">
      <div className="rb__track">
        {ribbon.ticks.map((t) => (
          <span key={t.hour} className="rb__tick" style={{ left: `${t.at * 100}%` }} aria-hidden="true">{t.label}</span>
        ))}
        {ribbon.now !== null ? <i className="rb__now" style={{ left: `${ribbon.now * 100}%` }} aria-hidden="true" /> : null}
        {ribbon.meetings.map((m) => {
          const size = 10 + Math.min(m.total, 6) * 3;
          const tone = m.pending ? "pending" : m.owe ? "owe" : m.total ? "some" : "none";
          const what = m.pending ? "not read yet" : m.total ? [m.owe && `${m.owe} you owe`, m.waiting && `${m.waiting} waiting`, m.decisions && plural(m.decisions, "decision")].filter(Boolean).join(", ") : "nothing to track";
          const on = selected === m.id;
          return (
            <Link
              key={m.id}
              href={on ? "/" : `/?meeting=${encodeURIComponent(m.id)}`}
              className={`rb__dot rb__dot--${tone}`}
              style={{ left: `${m.at * 100}%`, width: size, height: size }}
              aria-current={on ? "true" : undefined}
              aria-label={`${m.title}, ${m.time}: ${what}`}
              scroll={false}
            >
              <span className="rb__tip" aria-hidden="true">
                <b>{m.title}</b>
                <span>{m.time} · {what}</span>
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

/** "From Standup, 11:00 AM ×": shown while the list is filtered to one meeting. */
export function MeetingChip({ title, time }: { title: string; time: string }) {
  return (
    <p className="rb-chip" role="status">
      <span>Only from <b>{title}</b>{time ? <span className="db-mono">, {time}</span> : null}</span>
      <Link className="rb-chip__clear" href="/" scroll={false} aria-label="Show items from every meeting">Clear <span aria-hidden="true">×</span></Link>
    </p>
  );
}
