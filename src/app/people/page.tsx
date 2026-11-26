import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { initials, isActive, listPeople } from "@/lib/people";
import { confirmed } from "@/lib/directory/directory";
import { namesToCheck } from "@/lib/directory/review";
import { me } from "@/server/local/app";
import { pastDays } from "../_lib/days";
import { loadAll, shortDate } from "../_lib/lines";
import { MetPeople } from "./_met";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "People" };

// People: who you keep meeting while something is still open (src/app/people/_met.tsx), and the
// old table of everyone at ?view=all.
export default async function People({ searchParams }: { searchParams: Promise<{ all?: string; view?: string; p?: string }> }) {
  const sp = await searchParams;
  if (sp.view !== "all") return <MetPeople pick={sp.p ?? null} />;
  return <Everyone all={sp.all} />;
}

async function Everyone({ all }: { all?: string }) {
  const user = await me();
  if (!user) redirect("/setup");
  const now = new Date();
  const { items, meetings, people: dir } = await loadAll(user);
  const self = [user.name, ...user.aliases];
  const everyone = listPeople({ items, meetings, now, self, people: dir });
  const showAll = all === "1";
  const active = everyone.filter((p) => isActive(p, now));
  const quiet = everyone.length - active.length;
  const people = showAll ? everyone : active;
  const toCheck = namesToCheck({ items, meetings, people: confirmed({ people: dir, moved: {} }), self }, 0).length;
  const openCount = items.filter((i) => i.status === "open" && i.kind !== "decision").length;

  return (
    <Shell days={await pastDays(user.id, "")} current="people" openCount={openCount}>
      <div className="nr-titlebar">
        <h1 className="db-title">Everyone</h1>
        <Link className="db-link" href="/people">Back to People</Link>
        {toCheck ? (
          <Link className="nr-badge" href="/people/review">
            <span className="nr-badge__n">{toCheck}</span> {toCheck === 1 ? "name" : "names"} to check
          </Link>
        ) : null}
      </div>
      <p className="db-subtitle">
        {everyone.length
          ? showAll
            ? `Everyone from your meetings, ${everyone.length} in all, most open first.`
            : `${active.length} ${active.length === 1 ? "person" : "people"} with something open or seen in the last 30 days, most open first.`
          : "Nobody yet. People show up here once a meeting names them."}
      </p>
      {people.length ? (
        <div className="db-people" role="table" aria-label="People">
          <div className="db-people__row db-people__row--head" role="row">
            <span role="columnheader">Name</span>
            <span role="columnheader" className="db-people__num">You owe</span>
            <span role="columnheader" className="db-people__num">They owe</span>
            <span role="columnheader" className="db-people__num">Overdue</span>
            <span role="columnheader" className="db-people__last">Last met</span>
          </div>
          {people.map((p) => (
            <Link key={p.slug} href={`/people/${encodeURIComponent(p.slug)}`} className="db-people__row" role="row">
              <span role="cell" className="db-people__name">
                <span className="db-avatar" aria-hidden="true">{initials(p.name)}</span>
                <span className="nr-rowname">{p.name}</span>
                {!p.confirmed ? <span className="nr-check" title="Not checked yet: is this name right?">check</span> : null}
              </span>
              <span role="cell" className={`db-people__num${p.youOwe ? " db-people__num--owe" : ""}`}>
                {p.youOwe ? <><span className="db-mark db-mark--owe" aria-hidden="true" />{p.youOwe}</> : <Dash />}
              </span>
              <span role="cell" className="db-people__num">
                {p.theyOwe ? <><span className="db-mark db-mark--waiting" aria-hidden="true" />{p.theyOwe}</> : <Dash />}
              </span>
              <span role="cell" className={`db-people__num${p.overdue ? " db-people__num--late" : ""}`}>{p.overdue ? p.overdue : <Dash />}</span>
              <span role="cell" className="db-people__last">{p.lastMeetingAt ? shortDate(p.lastMeetingAt, user.timeZone) : <Dash />}</span>
            </Link>
          ))}
        </div>
      ) : null}
      {quiet ? (
        <p className="nr-more">
          {showAll
            ? <Link className="db-link" href="/people?view=all">Show only recent</Link>
            : <Link className="db-link" href="/people?view=all&all=1">Show everyone ({everyone.length})</Link>}
        </p>
      ) : null}
    </Shell>
  );
}

function Dash() {
  return <span className="db-people__none" aria-label="none">–</span>;
}

