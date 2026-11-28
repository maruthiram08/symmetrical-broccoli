import Link from "next/link";
import { BriefItem } from "@/components/BriefList";
import { BulkMove, RemoveProjectButton } from "@/components/structure/BulkMove";
import { starredFirst } from "@/lib/capture/items";
import type { Item, Meeting, User } from "@/lib/types";
import { shortDate, toLine } from "../_lib/lines";

interface P { slug: string; title: string; status: string | null }

const MAX_DECISIONS = 5;
const MAX_MEETINGS = 6;

/**
 * Everything by project: for each project, what you owe, what you're waiting on, its open
 * decisions and the meetings that fed it. Projects with the newest activity come first.
 */
export function ProjectBoardView({ projects, items, meetings, user, now, needs, topics }: { projects: P[]; items: Item[]; meetings: Meeting[]; user: User; now: Date; needs: number; topics: number }) {
  const byId = new Map(meetings.map((m) => [m.id, m]));
  const started = (i: Item) => byId.get(i.meetingId)?.startedAt ?? i.createdAt;
  const oldestFirst = (a: Item, b: Item) => started(a).localeCompare(started(b));
  const groups = projects.map((p) => {
    const mine = items.filter((i) => i.project === p.slug);
    const open = mine.filter((i) => i.status === "open");
    const fed = [...new Set(mine.map((i) => i.meetingId))].map((id) => byId.get(id)).filter((m): m is Meeting => !!m).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const last = [fed[0]?.startedAt ?? "", ...mine.map((i) => i.createdAt)].sort().pop() ?? "";
    return {
      p, fed, last,
      owe: starredFirst(open.filter((i) => i.kind === "owe").sort(oldestFirst)),
      waiting: starredFirst(open.filter((i) => i.kind === "waiting").sort(oldestFirst)),
      decisions: open.filter((i) => i.kind === "decision").sort((a, b) => started(b).localeCompare(started(a))),
      done: mine.filter((i) => i.status === "done").length,
      count: mine.length,
    };
  }).sort((a, b) => b.last.localeCompare(a.last));

  if (!projects.length) {
    return (
      <p className="db-section__empty">
        No projects yet. {topics ? <>Your meetings suggest {topics}: <Link className="db-link" href="/projects?view=filing">make one in one click</Link>.</> : <>Make one with Project › New project on any item.</>}
      </p>
    );
  }
  const back = "/projects";
  return (
    <>
      <p className="db-subtitle">
        {groups.length} project{groups.length === 1 ? "" : "s"}, newest activity first.
        {needs ? <> {needs} open item{needs === 1 ? "" : "s"} still <Link className="db-link" href="/projects?view=filing">need a project</Link>.</> : null}
      </p>
      {groups.map((g) => {
        const openN = g.owe.length + g.waiting.length;
        const bits = [
          g.owe.length ? `${g.owe.length} you owe` : "",
          g.waiting.length ? `${g.waiting.length} waiting` : "",
          g.decisions.length ? `${g.decisions.length} decision${g.decisions.length === 1 ? "" : "s"}` : "",
          g.done ? `${g.done} done` : "",
          g.fed[0] ? `last meeting ${shortDate(g.fed[0].startedAt, user.timeZone)}` : "",
          g.p.status && g.p.status !== "active" ? g.p.status : "",
        ].filter(Boolean);
        return (
          <details key={g.p.slug} className="pf-proj" open={openN > 0 || g.decisions.length > 0}>
            <summary className="pf-proj__head">
              <Link className="pf-proj__title" href={`/notes/${encodeURIComponent(g.p.slug)}`}>{g.p.title}</Link>
              <span className="st-list__meta">{bits.join(" · ") || "Nothing yet"}</span>
              {g.p.status && g.p.status !== "active" ? null : <RemoveProjectButton slug={g.p.slug} title={g.p.title} count={g.count} />}
            </summary>
            <div className="pf-proj__body">
              <BulkMove current={g.p.slug} rows={[...g.owe, ...g.waiting, ...g.decisions].map((i) => ({ id: i.id, text: i.text, meta: i.kind === "owe" ? "you owe" : i.kind === "waiting" ? "waiting on" : "decision" }))}>
              {g.owe.length ? (
                <div className="db-group">
                  <h3 className="db-group__title">You owe <span className="db-section__count">{g.owe.length}</span></h3>
                  {g.owe.map((i) => <BriefItem key={i.id} line={toLine(i, byId, user, now)} back={back} />)}
                </div>
              ) : null}
              {g.waiting.length ? (
                <div className="db-group">
                  <h3 className="db-group__title">Waiting on <span className="db-section__count">{g.waiting.length}</span></h3>
                  {g.waiting.map((i) => <BriefItem key={i.id} line={toLine(i, byId, user, now)} back={back} />)}
                </div>
              ) : null}
              {g.decisions.length ? (
                <div className="db-group">
                  <h3 className="db-group__title">Decisions <span className="db-section__count">{g.decisions.length}</span></h3>
                  <ul className="st-list">
                    {g.decisions.slice(0, MAX_DECISIONS).map((d) => (
                      <li key={d.id}><Link className="st-list__row" href={`/item/${encodeURIComponent(d.id)}`}><span className="db-mark db-mark--decision" aria-hidden="true" /><span>{d.text}</span><span className="st-list__meta">{shortDate(started(d), user.timeZone)}</span></Link></li>
                    ))}
                  </ul>
                  {g.decisions.length > MAX_DECISIONS ? <Link className="db-link pf-more" href={`/notes/${encodeURIComponent(g.p.slug)}`}>All {g.decisions.length} decisions</Link> : null}
                </div>
              ) : null}
              {g.fed.length ? (
                <p className="pf-meetings">
                  <span className="st-list__meta">Meetings:</span>
                  {g.fed.slice(0, MAX_MEETINGS).map((m) => (
                    <Link key={m.id} className="st-proj" href={`/meeting/${encodeURIComponent(m.id)}`}>{m.title || "Meeting"}, {shortDate(m.startedAt, user.timeZone)}</Link>
                  ))}
                  {g.fed.length > MAX_MEETINGS ? <span className="st-list__meta">+{g.fed.length - MAX_MEETINGS} more</span> : null}
                </p>
              ) : null}
              {!openN && !g.decisions.length ? <p className="db-section__empty">Nothing open in this project.</p> : null}
              </BulkMove>
            </div>
          </details>
        );
      })}
    </>
  );
}
