// Recurring meetings in the reading pane: calendar series when a calendar is linked, and series
// guessed from the time slot otherwise (the titles change every day, the 11 AM stays). The detail
// shows what to bring to the next one and every meeting in the series.
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { Detail, DetailBar, Head, IRows, Kv, LinkGroups, ListBar, NoneDetail, Ppl, RailCard, Sec, Stats, type LinkGroup } from "@/components/reading/Frame";
import { formatTime, localDate } from "@/lib/brief/time";
import { freshEvents, nextOccurrence, seriesMeetings } from "@/lib/calendar/series";
import { findSlots } from "@/lib/canvas/recurring";
import { cadenceOf, itemLine, seriesCounts } from "@/lib/reading/library";
import { dayName, shortDay } from "@/lib/reading/model";
import type { Meeting } from "@/lib/types";
import { getStore, me } from "@/server/local/app";
import { loadAll } from "../_lib/lines";
import { readingCtx } from "../_lib/reading";

interface SeriesView { key: string; href: string; title: string; meetings: Meeting[]; next: string | null; guessed: boolean; prep: string | null }

export async function Recurring({ pick }: { pick: { slot?: string; id?: string } | null }) {
  const user = await me();
  if (!user) redirect("/setup");
  const now = new Date();
  const tz = user.timeZone;
  const { items, meetings } = await loadAll(user);
  const ctx = readingCtx(user, meetings, now);
  const cache = await getStore().getCalendar(user.id);
  const events = freshEvents(cache, now);
  const cal: SeriesView[] = (cache?.series ?? []).map((s) => {
    const ms = seriesMeetings(s, meetings).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return { key: `id:${s.id}`, href: `/series/${s.id}`, title: s.title, meetings: ms, next: nextOccurrence(s, events, now)?.startsAt ?? null, guessed: false, prep: null };
  }).filter((s) => s.meetings.length);
  const slots: SeriesView[] = findSlots(meetings, now, tz, 60).map((s) => ({
    key: `slot:${s.key}`, href: `/series?slot=${encodeURIComponent(s.key)}`, title: `${s.label} meeting`, meetings: s.meetings, next: s.next, guessed: true, prep: `/canvas/prep?slot=${encodeURIComponent(s.key)}`,
  }));
  const openOf = (s: SeriesView) => seriesCounts(s.meetings, items).open;
  const all = [...cal, ...slots].sort((a, b) => openOf(b) - openOf(a) || b.meetings.length - a.meetings.length);
  const want = pick?.id ? `id:${pick.id}` : pick?.slot ? `slot:${pick.slot}` : null;
  const sel = want ? all.find((s) => s.key === want) ?? null : all[0] ?? null;
  if (want && !sel && pick?.id) notFound();

  const groups: LinkGroup[] = [{
    key: "series", label: "Most open first",
    rows: all.map((s) => {
      const first = s.meetings[s.meetings.length - 1];
      const last = s.meetings[0];
      return {
        key: s.key, href: s.href, title: s.title, mark: "ring",
        sub: `${cadenceOf(s.meetings, tz)} · ${s.meetings.length} meetings since ${shortDay(first.startedAt, tz)}`,
        last: last ? `Last: ${last.title || "Meeting"}, ${shortDay(last.startedAt, tz)}` : undefined,
        num: { n: openOf(s), label: "open" },
      };
    }),
    empty: "No meeting has come back at the same time three times yet.",
  }];
  const list = (
    <>
      <ListBar title="Recurring" count={`${all.length} series`} />
      <LinkGroups groups={groups} sel={sel?.key} limit={20} foot={slots.length ? "Grouped by the time they happen, because the titles change every day. Link a calendar and these become your real calendar series." : null} />
    </>
  );

  let detail;
  if (!sel) detail = <NoneDetail crumb={[{ label: "Recurring" }]} listHref="/series" text="Nothing recurring yet." />;
  else {
    const c = seriesCounts(sel.meetings.slice(0, 12), items);
    const ids = new Set(sel.meetings.map((m) => m.id));
    const open = items.filter((i) => ids.has(i.meetingId) && i.status === "open" && i.kind !== "decision")
      .sort((a, b) => (ctx.meetings.get(b.meetingId)?.startedAt ?? "").localeCompare(ctx.meetings.get(a.meetingId)?.startedAt ?? ""));
    const people = [...new Set(items.filter((i) => ids.has(i.meetingId) && i.person).map((i) => i.person!))]
      .filter((p) => ![user.name, ...user.aliases].some((s) => s.toLowerCase() === p.toLowerCase())).slice(0, 10);
    const titles = [...new Set(sel.meetings.map((m) => m.title).filter(Boolean))];
    const pos = all.indexOf(sel) + 1;
    const first = sel.meetings[sel.meetings.length - 1];
    detail = (
      <Detail
        bar={<DetailBar crumb={[{ label: "Recurring", href: "/series" }, { label: sel.title }]} listHref="/series" acts={<span className="rp-pos">{pos} of {all.length}</span>} />}
        rail={<>
          <Sec title="Details">
            <Kv rows={[
              ["Usually", sel.guessed ? sel.title.replace(/ meeting$/, "") : formatTime(sel.meetings[0].startedAt, tz)],
              ["Repeats", cadenceOf(sel.meetings, tz)],
              ["Since", shortDay(first.startedAt, tz)],
              sel.next ? ["Next", `${dayName(localDate(new Date(sel.next), tz))}, ${formatTime(sel.next, tz)}${sel.guessed ? " (guess)" : ""}`] : null,
            ]} />
          </Sec>
          <Sec title="Usually there"><Ppl names={people} href={(n) => `/people/${encodeURIComponent(n)}`} empty="No one named yet." /></Sec>
          {sel.prep ? <RailCard title="Prep for the next one" link={{ href: sel.prep, label: "Open the prep board" }}>Your last meetings in this slot and everything still open from them, on one board.</RailCard> : null}
        </>}
      >
        <Head
          kind="Recurring meeting" mark="ring" st={[{ text: sel.guessed ? "Guessed from times" : "From your calendar" }]} title={sel.title}
          lede={titles.length > 1 ? `The same slot under a new title each time: ${titles.slice(0, 3).join(", ")}${titles.length > 3 ? " and more" : ""}.` : `${sel.meetings.length} meetings so far.`}
          cta={sel.prep ? <Link className="rp-cbtn rp-cbtn--pri" href={sel.prep}><span className="rp-tick" aria-hidden="true" />Prep for the next one</Link> : null}
        />
        <Sec title={`Last ${Math.min(12, sel.meetings.length)} meetings`}>
          <Stats items={[{ n: Math.min(12, sel.meetings.length), label: "Meetings" }, { n: c.open, label: "Still open" }, { n: c.kept, label: "Kept" }, { n: c.decisions, label: "Decisions" }]} />
        </Sec>
        <Sec title={`Bring to the next one · ${open.length}`}>
          <IRows rows={open.map((i) => itemLine(i, ctx, `/item/${encodeURIComponent(i.id)}`, { badge: shortDay(ctx.meetings.get(i.meetingId)?.startedAt ?? i.createdAt, tz) }))} empty="Nothing open from this series." />
        </Sec>
        <Sec title="Meetings in this series">
          <div className="rp-mrows">
            {sel.meetings.slice(0, 12).map((m) => {
              const mc = seriesCounts([m], items);
              const line = [mc.open ? `${mc.open} open` : "", mc.decisions ? `${mc.decisions} decided` : "", mc.kept ? `${mc.kept} kept` : ""].filter(Boolean).join(" · ") || (m.processedAt ? "Nothing said" : "Not read yet");
              return <Link key={m.id} className="rp-mrow" href={`/meeting/${encodeURIComponent(m.id)}`}><span>{dayName(localDate(new Date(m.startedAt), tz))}</span><span>{m.title || "Meeting"}</span><span>{line}</span></Link>;
            })}
          </div>
        </Sec>
      </Detail>
    );
  }
  return <Shell current="series" list={list} detail={detail} show={pick ? "detail" : "list"} />;
}
