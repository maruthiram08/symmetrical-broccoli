import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { BriefItem, ClosedItem, Section } from "@/components/BriefList";
import { Shell } from "@/components/Shell";
import { LocalGraph } from "@/components/graph/LocalGraph";
import { isSpeakerLabel } from "@/lib/directory/speakers";
import { personSlug } from "@/lib/people";
import { getFileStore, getStore, me } from "@/server/local/app";
import { isHosted } from "@/server/mode";
import { MeetingCrossCheck } from "@/components/crosscheck/CrossCheck";
import { openCountFor, pastDays } from "../../_lib/days";
import { loadAll, shortDate, toClosedLine, toLine } from "../../_lib/lines";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const m = await getStore().getMeeting(decodeURIComponent((await params).id)).catch(() => null);
  return { title: m?.title ?? "Meeting" };
}

// One meeting: who was there (through the people directory), what came out of it, what it closed.
export default async function MeetingPage({ params }: { params: Promise<{ id: string }> }) {
  const id = decodeURIComponent((await params).id);
  const user = await me();
  if (!user) redirect("/setup");
  const { items, meetings } = await loadAll(user);
  const m = meetings.find((x) => x.id === id);
  if (!m) notFound();
  const now = new Date();
  const byId = new Map(meetings.map((x) => [x.id, x]));
  const back = `/meeting/${encodeURIComponent(m.id)}`;
  const from = items.filter((i) => i.meetingId === m.id && i.status !== "wrong" && i.status !== "inbox");
  const owe = from.filter((i) => i.kind === "owe" && i.status === "open");
  const waiting = from.filter((i) => i.kind === "waiting" && i.status === "open");
  const decisions = from.filter((i) => i.kind === "decision");
  const closed = items.filter((i) => i.closedByMeetingId === m.id && i.status === "done");
  const self = new Set([user.name, ...user.aliases].map((s) => s.toLowerCase()));
  const who = m.participants.filter((p) => !isSpeakerLabel(p) && !self.has(p.toLowerCase()));
  const time = new Intl.DateTimeFormat("en-US", { timeZone: user.timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(m.startedAt));
  return (
    <Shell days={await pastDays(user.id, "")} current="meeting" openCount={await openCountFor(user.id)}>
      <p className="db-crumb"><Link className="db-link" href="/graph">Graph</Link></p>
      <h1 className="db-title">{m.title || "Meeting"}</h1>
      <p className="db-subtitle">
        {shortDate(m.startedAt, user.timeZone)}, {time}
        {who.length ? <> · with {who.map((p, k) => <span key={p}>{k ? ", " : ""}<Link className="db-link" href={`/people/${encodeURIComponent(personSlug(p))}`}>{p}</Link></span>)}</> : null}
        {m.link ? <> · <a className="db-link" href={m.link} target="_blank" rel="noopener noreferrer">Notes in Wispr Flow</a></> : null}
      </p>
      <Section title="You owe" count={owe.length ? String(owe.length) : undefined} empty="Nothing you owe from this meeting.">
        {owe.map((i) => <BriefItem key={i.id} line={toLine(i, byId, user, now)} back={back} />)}
      </Section>
      <Section title="Waiting on" count={waiting.length ? String(waiting.length) : undefined} empty="Nobody owes you anything from this meeting.">
        {waiting.map((i) => <BriefItem key={i.id} line={toLine(i, byId, user, now)} back={back} />)}
      </Section>
      {decisions.length ? (
        <Section title="Decisions" count={String(decisions.length)}>
          {decisions.map((i) => <BriefItem key={i.id} line={toLine(i, byId, user, now)} back={back} />)}
        </Section>
      ) : null}
      {closed.length ? (
        <Section title="Closed in this meeting" count={String(closed.length)}>
          {closed.map((i) => <ClosedItem key={i.id} line={toClosedLine(i, byId, user)} />)}
        </Section>
      ) : null}
      {isHosted() ? null : <MeetingCrossCheck rec={await getFileStore().getCrossCheck(m.id)} />}
      <LocalGraph user={user} center={`meeting:${m.id}`} />
    </Shell>
  );
}
