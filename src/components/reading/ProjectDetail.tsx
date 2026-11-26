// One project in the detail pane: what you owe, what you're waiting on and its decisions, with the
// meetings and people that fed it and how items get filed.
import Link from "next/link";
import { formatTime } from "@/lib/brief/time";
import { badgeOf, markOf, shortDay, type Ctx, type ProjectSummary } from "@/lib/reading/model";
import type { Item } from "@/lib/types";
import { BulkMove, RemoveProjectButton } from "../structure/BulkMove";
import { Bar, CrumbLine } from "./ItemDetail";
import { AddButton } from "./Pane";

export function ProjectDetail({ p, ctx, href, status }: { p: ProjectSummary; ctx: Ctx; href: (id: string) => string; status: string | null }) {
  const secs: Array<{ label: string; items: Item[]; empty: string }> = [
    { label: "You owe", items: p.owe, empty: "Nothing owed on this project." },
    { label: "Waiting on", items: p.waiting, empty: "Nobody owes you anything here." },
    { label: "Decisions", items: p.decisions, empty: "No decisions yet." },
  ];
  const all = [...p.owe, ...p.waiting, ...p.decisions];
  return (
    <div className="rp-wrap">
      <Bar className="rp-bar--det">
        <CrumbLine crumb={{ page: "Projects", group: p.title }} />
        <div className="rp-acts">
          <Link className="rp-btn" href={`/notes/${encodeURIComponent(p.slug)}`}>Open note</Link>
          <AddButton text={`+${p.slug} `} label="Add item" />
        </div>
      </Bar>
      <div className="rp-dbody">
        <div className="rp-main">
          <div>
            <div className="rp-kind"><span className="rp-m rp-m--proj" aria-hidden="true" />Project{status && status !== "active" ? <span className="rp-st">{status}</span> : null}</div>
            <h1 className="rp-title">{p.title}</h1>
          </div>
          <div className="rp-stats">
            <div><b>{p.owe.length}</b><span>You owe</span></div>
            <div><b>{p.waiting.length}</b><span>Waiting on</span></div>
            <div><b>{p.decisions.length}</b><span>Decisions</span></div>
            <div><b>{p.kept}</b><span>Kept</span></div>
          </div>
          <BulkMove current={p.slug} rows={all.map((i) => ({ id: i.id, text: i.text, meta: i.kind === "owe" ? "you owe" : i.kind === "waiting" ? "waiting on" : "decision" }))}>
            {secs.map((s) => (
              <section key={s.label} className="rp-sec">
                <h2>{s.label} · {s.items.length}</h2>
                <div className="rp-sib">
                  {s.items.length ? s.items.map((i) => (
                    <Link key={i.id} href={href(i.id)} scroll={false}>
                      <span className={`rp-m rp-m--${markOf(i, ctx.now)}`} aria-hidden="true" />
                      <span className="rp-sib__t">{i.text}</span>
                      <span className={`rp-sib__b${markOf(i, ctx.now) === "late" ? " rp-late" : ""}`}>{badgeOf(i, ctx, { showBack: true })}</span>
                    </Link>
                  )) : <div className="rp-sib__none"><span /><span>{s.empty}</span><span /></div>}
                </div>
              </section>
            ))}
          </BulkMove>
          {status && status !== "active" ? null : <div className="rp-remove"><RemoveProjectButton slug={p.slug} title={p.title} count={all.length + p.kept} /></div>}
        </div>
        <aside className="rp-rail" aria-label="About this project">
          <section className="rp-sec">
            <h2>Meetings</h2>
            {p.meetings.length ? (
              <div className="rp-mlist">
                {p.meetings.slice(0, 4).map((m) => (
                  <Link key={m.id} href={`/meeting/${encodeURIComponent(m.id)}`}><span>{m.title || "Meeting"}</span><span>{shortDay(m.startedAt, ctx.timeZone)}, {formatTime(m.startedAt, ctx.timeZone)}</span></Link>
                ))}
              </div>
            ) : <p className="rp-quiet">No meetings yet.</p>}
          </section>
          <section className="rp-sec">
            <h2>People</h2>
            <div className="rp-ppl">{p.people.length ? p.people.slice(0, 12).map((n) => <span key={n}>{n}</span>) : <span>Only you so far</span>}</div>
          </section>
          <section className="rp-sec">
            <h2>How items get here</h2>
            <p className="rp-note">Filed automatically from the meeting they came from. Move one with <span className="rp-kbd">P</span> and it learns.</p>
            <Link className="rp-pcard__go" href="/projects?view=filing">See filing</Link>
          </section>
        </aside>
      </div>
    </div>
  );
}
