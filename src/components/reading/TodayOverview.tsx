// Today's detail pane before anything is picked: the day at a glance, the three to do first (each
// with why), today's meetings, what was kept, and what comes back tomorrow and after.
import Link from "next/link";
import type { ReactNode } from "react";
import { addDays, formatTime, localDate } from "@/lib/brief/time";
import { comingBack, daySentence, dayName, doFirst, longDay, markOf, partOfDay, todaySets, todaysMeetings, type Ctx } from "@/lib/reading/model";
import type { Item, Meeting } from "@/lib/types";
import { Bar, CrumbLine } from "./ItemDetail";

const GO = <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>;
const mk = (m: string) => <span className={`rp-m rp-m--${m}`} aria-hidden="true" />;

export function TodayOverview({ items, meetings, ctx, href, extras, after }: {
  items: Item[]; meetings: Meeting[]; ctx: Ctx;
  /** The URL that opens one item. */
  href: (id: string) => string;
  /** Today's cards that come first when there are any: the next meeting's prep, changed decisions, closed since you looked. */
  extras?: ReactNode;
  /** After Do first: today's routines. */
  after?: ReactNode;
}) {
  const s = todaySets(items, ctx);
  const first = doFirst(items, ctx);
  const cards = todaysMeetings(items, meetings, ctx);
  const today = localDate(ctx.now, ctx.timeZone);
  const tomorrow = addDays(today, 1);
  const back = comingBack(items, ctx);
  const hint = (i: Item, why: string) => {
    const who = i.person?.split(/\s+/)[0];
    if (why.endsWith("late")) return who ? `Mark done or message ${who}` : "Mark done, or block 30 minutes for it";
    if (why.startsWith("Oldest")) return "Oldest open promise";
    if (why.includes("open with you")) return "One of several with them";
    if (why.includes("one meeting")) return `From ${ctx.meetings.get(i.meetingId)?.title || "one meeting"}`;
    return "Still open";
  };
  return (
    <div className="rp-wrap">
      <Bar className="rp-bar--det">
        <CrumbLine crumb={{ page: "Today", group: "Overview" }} />
        <div className="rp-acts">
          <Link className="rp-btn" href="/today">Open daily note</Link>
          {first[0] ? <Link className="rp-btn rp-btn--pri" href={href(first[0].item.id)} scroll={false}>Start with #1</Link> : null}
        </div>
      </Bar>
      <div className="rp-dbody">
        <div className="rp-main">
          <div>
            <div className="rp-ovdate">{partOfDay(ctx.now, ctx.timeZone)} · {formatTime(ctx.now.toISOString(), ctx.timeZone)}</div>
            <h1 className="rp-ovh">{longDay(today)}</h1>
            <p className="rp-ovl">{daySentence({ meetings: cards.length, kept: s.kept.length, late: s.late.length, tomorrow: s.tomorrow.length })}</p>
          </div>
          <div className="rp-stats">
            <div className={s.late.length ? "rp-stats--late" : undefined}><b>{s.late.length}</b><span>Late</span></div>
            <div><b>{s.tomorrow.length}</b><span>Back tomorrow</span></div>
            <div><b>{s.kept.length}</b><span>Kept today</span></div>
            <div><b>{cards.length}</b><span>{cards.length === 1 ? "Meeting" : "Meetings"}</span></div>
          </div>
          {extras}
          <section className="rp-sec">
            <h2>Do first</h2>
            {first.length ? (
              <div className="rp-handoff">
                {first.map((f, k) => (
                  <Link key={f.item.id} className={`rp-ho${k === 0 ? " rp-ho--rec" : ""}`} href={href(f.item.id)} scroll={false}>
                    <span className="rp-ho__hi rp-ho__n">{k + 1}</span>
                    <b>{f.item.text}</b>
                    <span className={`rp-why${f.reason.late ? " rp-why--late" : ""}`}>{f.reason.text}</span>
                    <span className="rp-ho__go">{GO}</span>
                    <span className="rp-ho__s">{hint(f.item, f.reason.text)} · {f.item.person || "just you"}</span>
                  </Link>
                ))}
              </div>
            ) : <p className="rp-quiet">Nothing open. A clear day.</p>}
          </section>
          {after}
          <section className="rp-sec">
            <h2>{cards.length === 1 ? "Today's meeting" : `Today's meetings${cards.length ? ` · ${cards.length}` : ""}`}</h2>
            {cards.length ? cards.map((c) => (
              <div key={c.meeting.id} className="rp-mcard">
                <div className="rp-mcard__top"><Link href={`/meeting/${encodeURIComponent(c.meeting.id)}`}><b>{c.meeting.title || "Meeting"}</b></Link><span className="rp-mcard__tm">{c.time}</span></div>
                {c.rows.length ? (
                  <div className="rp-sib">
                    {c.rows.map((r) => (
                      <Link key={r.id} href={href(r.id)} scroll={false}>
                        {mk(r.mark)}<span className={`rp-sib__t${r.done ? " rp-sib__t--done" : ""}`}>{r.title}</span><span className={`rp-sib__b${r.late ? " rp-late" : ""}`}>{r.note}</span>
                      </Link>
                    ))}
                  </div>
                ) : <p className="rp-mcard__note">No promises or decisions in it.</p>}
                {c.notPromises ? <p className="rp-mcard__note">{c.notPromises} other line{c.notPromises === 1 ? " from this meeting was" : "s from this meeting were"} marked &ldquo;not a promise&rdquo;.</p> : null}
              </div>
            )) : <p className="rp-quiet">No meetings yet today.</p>}
          </section>
          {s.kept.length ? (
            <section className="rp-sec">
              <h2>Kept today · {s.kept.length}</h2>
              <div className="rp-sib">
                {s.kept.slice(0, 8).map((i) => (
                  <Link key={i.id} href={href(i.id)} scroll={false}>{mk("done")}<span className="rp-sib__t rp-sib__t--done">{i.text}</span><span className="rp-sib__b">{i.person || "You"}</span></Link>
                ))}
                {s.kept.length > 8 ? <a className="rp-sib__more" href="#rp-g-kept">{s.kept.length - 8} more in the list</a> : null}
              </div>
            </section>
          ) : null}
        </div>
        <aside className="rp-rail" aria-label="Coming up">
          <section className="rp-sec">
            <h2>Tomorrow, {dayName(tomorrow)} · {s.tomorrow.length}</h2>
            {s.tomorrow.length ? (
              <div className="rp-rlist">
                {s.tomorrow.map((i) => <Link key={i.id} href={href(i.id)} scroll={false}>{mk(markOf(i, ctx.now))}<span>{i.text}</span></Link>)}
              </div>
            ) : <p className="rp-quiet">Nothing comes back tomorrow.</p>}
          </section>
          <section className="rp-sec">
            <h2>Coming back</h2>
            {back.length ? (
              <div className="rp-wk">{back.map((b) => <div key={b.date}><span>{b.label}</span><b>{b.count}</b></div>)}</div>
            ) : <p className="rp-quiet">Nothing else snoozed.</p>}
          </section>
        </aside>
      </div>
    </div>
  );
}
