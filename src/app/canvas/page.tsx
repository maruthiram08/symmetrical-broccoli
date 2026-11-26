import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { mondayOf } from "@/lib/canvas/build";
import { findSlots } from "@/lib/canvas/recurring";
import { findTopics } from "@/lib/canvas/topics";
import { addDays, localDate } from "@/lib/brief/time";
import { isSpeakerLabel } from "@/lib/directory/speakers";
import { getStore, me } from "@/server/local/app";
import { currentAi } from "@/server/ai-state";
import { canvasCtx, openWindowCounts } from "@/server/canvas/data";
import { openCountFor, pastDays } from "../_lib/days";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Canvas" };

const short = (iso: string, tz: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: tz });

// Five ways to see your meetings as a canvas. Each one is drawn from what the meetings said.
export default async function CanvasHome() {
  const user = await me();
  if (!user) redirect("/setup");
  const c = await canvasCtx(user);
  const tz = user.timeZone;
  const since = new Date(c.now.getTime() - 30 * 86400000).toISOString();
  const topics = findTopics(c.meetings, c.items, since, 10);
  const slots = findSlots(c.meetings, c.now, tz).slice(0, 3);
  const upcoming = ((await getStore().getUpcoming(user.id))?.meetings ?? []).filter((m) => Date.parse(m.startsAt) > c.now.getTime()).slice(0, 3);
  const people = new Map<string, number>();
  for (const i of c.items) if (i.status === "open" && i.kind !== "decision" && i.person && !isSpeakerLabel(i.person) && !c.self.some((s) => s.toLowerCase() === i.person!.toLowerCase())) people.set(i.person, (people.get(i.person) ?? 0) + 1);
  const topPeople = [...people].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const running = openWindowCounts();
  const owe = c.items.filter((i) => i.status === "open" && i.kind === "owe")
    .sort((a, b) => (running.get(b.id) ?? 0) - (running.get(a.id) ?? 0) || (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999") || b.createdAt.localeCompare(a.createdAt)).slice(0, 6);
  const flags = (await currentAi()).ai.contradictions().filter((x) => x.status === "open");
  const itemsById = new Map(c.items.map((i) => [i.id, i]));
  const conflicts = flags.filter((f) => itemsById.get(f.newId) && itemsById.get(f.oldId)?.status === "open").slice(0, 4);
  const recent = c.meetings.filter((m) => !m.duplicateOf && m.startedAt >= since).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 40);
  const monday = mondayOf(localDate(c.now, tz));

  return (
    <Shell days={await pastDays(user.id, "")} current="canvas" openCount={await openCountFor(user.id)} wide>
      <h1 className="db-title">Canvas</h1>
      <p className="db-subtitle">Your meetings, drawn as a canvas. Each view builds itself from what was said, so there is nothing to set up or keep tidy.</p>
      <div className="cv-home">
        <section className="cv-card">
          <h2><span className="cv-num">1</span>Project map</h2>
          <p>Every meeting about one topic on one canvas, with what came out of each and what closed it.</p>
          {topics.length ? <ul className="cv-list">{topics.map((t) => <li key={t.key}><Link href={`/canvas/map?topic=${encodeURIComponent(t.key)}`}>{t.label}</Link><span>{t.meetingIds.length} meetings · last {short(t.last, tz)}</span></li>)}</ul> : <p className="cv-none">No topic has come up in two meetings yet.</p>}
          <form action="/canvas/map" className="cv-form"><input id="cv-topic" name="topic" className="db-input" placeholder="Or type a topic, like dividend" aria-label="Topic" /><button className="cv-btn cv-btn--p">Map it</button></form>
        </section>
        <section className="cv-card">
          <h2><span className="cv-num">2</span>Meeting prep</h2>
          <p>Your last meetings and everything open, with Ask reading only what you leave plugged in.</p>
          <ul className="cv-list">
            {upcoming.map((u) => <li key={u.calendarId}><Link href={`/canvas/prep?upcoming=${encodeURIComponent(u.calendarId)}`}>{u.title}</Link><span>{short(u.startsAt, tz)}, {new Date(u.startsAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz })}</span></li>)}
            {slots.map((s) => <li key={s.key}><Link href={`/canvas/prep?slot=${encodeURIComponent(s.key)}`}>Your {s.label} meeting</Link><span>met {s.meetings.length} times · next {short(s.next, tz)}</span></li>)}
            {topPeople.map(([p, n]) => <li key={p}><Link href={`/canvas/prep?person=${encodeURIComponent(p)}`}>{p}</Link><span>{n} open</span></li>)}
          </ul>
          {!upcoming.length && !slots.length && !topPeople.length ? <p className="cv-none">Nothing to prep yet.</p> : null}
        </section>
        <section className="cv-card">
          <h2><span className="cv-num">3</span>Start in a new window</h2>
          <p>Open Claude, Claude Code or a draft that already has the quote, the meeting and what was decided.</p>
          {owe.length ? <ul className="cv-list">{owe.map((i) => <li key={i.id}><Link href={`/canvas/start/${encodeURIComponent(i.id)}`}>{i.text}</Link><span>{running.get(i.id) ? `${running.get(i.id)} window${running.get(i.id) === 1 ? "" : "s"} open` : i.person && !isSpeakerLabel(i.person) ? `for ${i.person}` : ""}</span></li>)}</ul> : <p className="cv-none">Nothing open that you owe.</p>}
        </section>
        <section className="cv-card">
          <h2><span className="cv-num">4</span>Combine threads</h2>
          <p>Two meetings side by side. Decisions that disagree are found for you.</p>
          {conflicts.length ? <ul className="cv-list">{conflicts.map((f) => <li key={f.id}><Link href={`/canvas/combine?c=${encodeURIComponent(f.id)}`}>{f.note}</Link><span>disagree</span></li>)}</ul> : <p className="cv-none">No decisions disagree right now.</p>}
          <form action="/canvas/combine" className="cv-form cv-form--two">
            <select id="cv-a" name="a" className="db-input" aria-label="First meeting" defaultValue={recent[1]?.id}>{recent.map((m) => <option key={m.id} value={m.id}>{short(m.startedAt, tz)} · {m.title}</option>)}</select>
            <select id="cv-b" name="b" className="db-input" aria-label="Second meeting" defaultValue={recent[0]?.id}>{recent.map((m) => <option key={m.id} value={m.id}>{short(m.startedAt, tz)} · {m.title}</option>)}</select>
            <button className="cv-btn cv-btn--p">Combine</button>
          </form>
        </section>
        <section className="cv-card">
          <h2><span className="cv-num">5</span>Friday review</h2>
          <p>The week: what was decided, what’s still open, what’s stuck. Drag anything into next week.</p>
          <ul className="cv-list">
            <li><Link href={`/canvas/week?w=${monday}`}>This week</Link><span>from {short(`${monday}T12:00:00Z`, "UTC")}</span></li>
            <li><Link href={`/canvas/week?w=${addDays(monday, -7)}`}>Last week</Link><span>from {short(`${addDays(monday, -7)}T12:00:00Z`, "UTC")}</span></li>
          </ul>
        </section>
      </div>
      <p className="cv-foot">{recent.length} meetings in the last 30 days.</p>
    </Shell>
  );
}
