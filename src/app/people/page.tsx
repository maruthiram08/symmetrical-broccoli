import Link from "next/link";
import { redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { initials, listPeople } from "@/lib/people";
import { me } from "@/server/local/app";
import { pastDays } from "../_lib/days";
import { loadAll, shortDate } from "../_lib/lines";

export const dynamic = "force-dynamic";

// Everyone named on an item, busiest first.
export default async function People() {
  const user = await me();
  if (!user) redirect("/setup");
  const now = new Date();
  const { items, meetings } = await loadAll(user);
  const people = listPeople({ items, meetings, now, self: [user.name, ...user.aliases] });
  const openCount = items.filter((i) => i.status === "open" && i.kind !== "decision").length;

  return (
    <Shell days={await pastDays(user.id, "")} current="people" openCount={openCount}>
      <h1 className="db-title">People</h1>
      <p className="db-subtitle">
        {people.length ? `${people.length} ${people.length === 1 ? "person" : "people"} from your meetings, most open first.` : "Nobody yet. People show up here once a meeting names them."}
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
                {p.name}
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
    </Shell>
  );
}

function Dash() {
  return <span className="db-people__none" aria-label="none">–</span>;
}

