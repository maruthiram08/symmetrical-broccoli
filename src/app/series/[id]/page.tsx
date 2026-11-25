import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { BriefItem, Section } from "@/components/BriefList";
import { Mark } from "@/components/Mark";
import { Shell } from "@/components/Shell";
import { formatTime } from "@/lib/brief/time";
import { freshEvents, seriesDetail } from "@/lib/calendar/series";
import { getStore, me } from "@/server/local/app";
import { pastDays } from "../../_lib/days";
import { loadAll, shortDate, toLine } from "../../_lib/lines";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const user = await me();
  const cache = user ? await getStore().getCalendar(user.id) : null;
  return { title: cache?.series.find((x) => x.id === id)?.title ?? "Recurring meeting" };
}

// One recurring meeting (a standup, a 1:1): promises and decisions from every occurrence, newest first.
export default async function Series({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await me();
  if (!user) redirect("/setup");
  const now = new Date();
  const cache = await getStore().getCalendar(user.id);
  const s = cache?.series.find((x) => x.id === id);
  if (!s) notFound();
  const { items, meetings } = await loadAll(user);
  const d = seriesDetail(s, { meetings, items, events: freshEvents(cache, now), now, self: [user.name, ...user.aliases] });
  const byId = new Map(meetings.map((m) => [m.id, m]));
  const back = `/series/${s.id}`;
  const openCount = items.filter((i) => i.status === "open" && i.kind !== "decision").length;
  const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;
  const facts = [
    n(d.meetings.length, "meeting") + " recorded",
    d.counts.open ? `${d.counts.open} open` : null,
    d.counts.done ? `${d.counts.done} kept` : null,
    d.counts.decisions ? n(d.counts.decisions, "decision") : null,
  ].filter(Boolean).join(" · ");
  const nextLabel = d.next
    ? `${new Intl.DateTimeFormat("en-GB", { timeZone: user.timeZone, weekday: "short", day: "numeric", month: "short" }).format(new Date(d.next.startsAt))}, ${formatTime(d.next.startsAt, user.timeZone)}`
    : null;

  return (
    <Shell days={await pastDays(user.id, "")} current="series" openCount={openCount}>
      <p className="db-crumb"><Link className="db-link" href="/series">Recurring meetings</Link></p>
      <h1 className="db-title">{s.title}</h1>
      <p className="db-subtitle">
        {facts}
        {nextLabel ? <> · Next <span className="db-mono">{nextLabel}</span></> : null}
      </p>
      {d.people.length ? <p className="cal-series__people">With {d.people.join(", ")}</p> : null}

      {d.meetings.length ? d.meetings.map(({ meeting: m, items: its }) => (
        <Section key={m.id} title={`${shortDate(m.startedAt, user.timeZone)}, ${formatTime(m.startedAt, user.timeZone)}`} count={its.length ? String(its.length) : undefined} empty={m.processedAt ? "No promises or decisions." : "Not read yet."}>
          {its.map((i) =>
            i.status === "open" || i.kind === "decision" ? (
              <BriefItem key={i.id} line={toLine(i, byId, user, now)} back={back} />
            ) : (
              <div key={i.id} className="db-item db-item--done">
                <span className="db-item__icon"><Mark kind="done" /></span>
                <span className="db-item__text">{i.text}</span>
                <span className="db-item__side" />
                <span className="db-item__evidence">
                  {i.closeQuote ? <>Closed: &ldquo;{i.closeQuote}&rdquo;</> : "You marked it done"}
                  {i.closedAt ? `, ${shortDate(i.closedAt, user.timeZone)}` : ""}.
                </span>
              </div>
            ),
          )}
        </Section>
      )) : <p className="db-section__empty">No recorded meetings of this series yet.</p>}
    </Shell>
  );
}
