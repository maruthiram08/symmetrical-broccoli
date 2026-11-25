import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { formatTime } from "@/lib/brief/time";
import { freshEvents, nextOccurrence, seriesMeetings, seriesPeople } from "@/lib/calendar/series";
import { getStore, me } from "@/server/local/app";
import { pastDays } from "../_lib/days";
import { loadAll, shortDate } from "../_lib/lines";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Recurring meetings" };

// Every recurring meeting we've recorded, the one met most recently first.
export default async function AllSeries() {
  const user = await me();
  if (!user) redirect("/setup");
  const now = new Date();
  const cache = await getStore().getCalendar(user.id);
  const { items, meetings } = await loadAll(user);
  const events = freshEvents(cache, now);
  const rows = (cache?.series ?? [])
    .map((s) => {
      const ms = seriesMeetings(s, meetings);
      const ids = new Set(ms.map((m) => m.id));
      return {
        s, last: ms[0]?.startedAt ?? null, count: ms.length, next: nextOccurrence(s, events, now),
        people: seriesPeople(s, meetings, [user.name, ...user.aliases]),
        open: items.filter((i) => ids.has(i.meetingId) && i.status === "open" && i.kind !== "decision").length,
      };
    })
    .filter((r) => r.count > 0)
    .sort((a, b) => (b.last ?? "").localeCompare(a.last ?? ""));
  const openCount = items.filter((i) => i.status === "open" && i.kind !== "decision").length;

  return (
    <Shell days={await pastDays(user.id, "")} current="series" openCount={openCount}>
      <h1 className="db-title">Recurring meetings</h1>
      <p className="db-subtitle">
        {rows.length ? "Standups, 1:1s and other series, with what came out of every meeting." : cache ? "No recurring meetings found yet." : "The calendar hasn't been read yet. It's checked every 30 minutes."}
      </p>
      {rows.length ? (
        <ul className="cal-series-list">
          {rows.map((r) => (
            <li key={r.s.id}>
              <Link className="cal-series-list__row" href={`/series/${r.s.id}`}>
                <span className="cal-series-list__title">{r.s.title}</span>
                <span className="cal-series-list__meta">
                  {r.count} recorded{r.open ? ` · ${r.open} open` : ""}{r.people.length ? ` · ${r.people.slice(0, 3).join(", ")}${r.people.length > 3 ? ` +${r.people.length - 3}` : ""}` : ""}
                </span>
                <span className="cal-series-list__when db-mono">
                  {r.next ? `Next ${shortDate(r.next.startsAt, user.timeZone)}, ${formatTime(r.next.startsAt, user.timeZone)}` : r.last ? `Last ${shortDate(r.last, user.timeZone)}` : ""}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </Shell>
  );
}
