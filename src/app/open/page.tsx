import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { BriefItem, Section } from "@/components/BriefList";
import { Shell } from "@/components/Shell";
import { peekInfo } from "@/lib/brief/build";
import { formatTime, dueLabel, lateLabel } from "@/lib/brief/time";
import type { BriefLine, Item } from "@/lib/types";
import { getStore, me } from "@/server/local/app";
import { pastDays } from "../_lib/days";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "All open" };

// Everything still open, oldest promise first, grouped by person.
export default async function AllOpen() {
  const user = await me();
  if (!user) redirect("/setup");
  const store = getStore();
  const now = new Date();
  const open = (await store.listItems(user.id, { status: "open" })).filter((i) => i.kind !== "decision");

  const meetings = new Map<string, { title: string; startedAt: string; link?: string | null } | null>();
  for (const i of open) if (!meetings.has(i.meetingId)) meetings.set(i.meetingId, await store.getMeeting(i.meetingId));
  const started = (i: Item) => meetings.get(i.meetingId)?.startedAt ?? i.createdAt;

  const line = (i: Item): BriefLine => {
    const m = meetings.get(i.meetingId);
    const late = i.dueAt && Date.parse(i.dueAt) < now.getTime() ? Math.floor((now.getTime() - Date.parse(i.dueAt)) / 60000) : null;
    const day = m ? new Date(m.startedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: user.timeZone }) : "";
    return {
      itemId: i.id, kind: i.kind, text: i.text, person: i.person, quote: i.quote,
      meetingTitle: m ? `${m.title}, ${day}` : "a meeting",
      meetingTime: m ? formatTime(m.startedAt, user.timeZone) : "",
      dueLabel: i.dueAt && late === null ? dueLabel(i.dueAt, now, user.timeZone) : null,
      lateMinutes: late, lateLabel: late !== null ? lateLabel(late) : null,
      meetingId: i.meetingId, peek: peekInfo(i, m ?? null, user.timeZone),
    };
  };

  const group = (kind: Item["kind"]) => {
    const byPerson = new Map<string, Item[]>();
    for (const i of open.filter((x) => x.kind === kind).sort((a, b) => started(a).localeCompare(started(b)))) {
      const k = i.person?.trim() || "No one named";
      byPerson.set(k, [...(byPerson.get(k) ?? []), i]);
    }
    return [...byPerson.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  };
  const owe = group("owe");
  const waiting = group("waiting");
  const count = (g: Array<[string, Item[]]>) => g.reduce((n, [, xs]) => n + xs.length, 0);

  return (
    <Shell days={await pastDays(user.id, "")} current="open" openCount={open.length}>
      <h1 className="db-title">All open</h1>
      <p className="db-subtitle">{open.length} promises not closed yet, oldest first, grouped by person.</p>
      <Section title="You owe" count={String(count(owe))} empty="Nothing owed.">
        {owe.map(([person, items]) => (
          <div key={person} className="db-group">
            <h3 className="db-group__title">{person} <span className="db-section__count">{items.length}</span></h3>
            {items.map((i) => <BriefItem key={i.id} line={line(i)} back="/open" />)}
          </div>
        ))}
      </Section>
      <Section title="Waiting on" count={String(count(waiting))} empty="Nobody owes you anything.">
        {waiting.map(([person, items]) => (
          <div key={person} className="db-group">
            <h3 className="db-group__title">{person} <span className="db-section__count">{items.length}</span></h3>
            {items.map((i) => <BriefItem key={i.id} line={line(i)} back="/open" />)}
          </div>
        ))}
      </Section>
    </Shell>
  );
}
