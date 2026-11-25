import { redirect } from "next/navigation";
import { BriefItem, ClosedItem, Section } from "@/components/BriefList";
import { CloseMoment, SummaryLinks } from "@/components/CloseWrap";
import { Shell } from "@/components/Shell";
import { buildBrief } from "@/lib/brief/build";
import { getStore, me } from "@/server/local/app";
import { takeCloseMoment } from "@/server/local/closewrap";
import { checkMeetingsNow, setStatus } from "./actions";
import { formatBriefTime } from "./_lib/time";
import { pastDays } from "./_lib/days";
import { DayRibbon, MeetingChip } from "@/components/DayRibbon";
import { PrepCard } from "@/components/PrepCard";
import { formatTime, localDayBounds } from "@/lib/brief/time";
import { buildRibbon } from "@/lib/wow/ribbon";
import { prepCard } from "@/server/local/prep";
import { onboardingStep } from "@/server/local/onboarding";
import { pullState } from "@/server/local/scheduler";

const countOf = (l: unknown[]) => (l.length ? String(l.length) : undefined);
/** "in 22 min", "in 1 h 5 min" */
function minutesUntil(iso: string, now: Date): string {
  const m = Math.max(1, Math.round((Date.parse(iso) - now.getTime()) / 60000));
  return m < 60 ? `in ${m} min` : `in ${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}

export const dynamic = "force-dynamic";

export default async function Today({ searchParams }: { searchParams: Promise<{ undo?: string; was?: string; meeting?: string }> }) {
  const user = await me();
  if (!user) redirect("/welcome");
  const store = getStore();
  const conn = await store.getConnection(user.id);
  if (onboardingStep(user, conn, pullState()?.running ?? false) !== "done") redirect("/welcome");
  if (!conn) redirect("/welcome");

  const now = new Date();
  const b = await buildBrief(store, user, now);
  const closedSinceLook = await takeCloseMoment(store, user, now);
  const { undo, was, meeting } = await searchParams;
  const { startIso, endIso } = localDayBounds(b.date, user.timeZone);
  const todays = await store.listMeetingsBetween(user.id, startIso, endIso);
  const ribbon = buildRibbon({ date: b.date, timeZone: user.timeZone, meetings: todays, items: await store.listItems(user.id), now });
  const only = meeting ? todays.find((m) => m.id === meeting) ?? null : null;
  const keep = <T extends { meetingId?: string }>(lines: T[]) => (only ? lines.filter((l) => l.meetingId === only.id) : lines);
  const prep = await prepCard(store, user, now);
  const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;
  const openCount = (await store.listItems(user.id, { status: "open" })).filter((i) => i.kind !== "decision").length;
  const owedCount = b.youOwe.length ? `${b.youOwe.length}${b.wrap.late ? ` · ${b.wrap.late} late` : ""}` : undefined;

  return (
    <Shell
      days={await pastDays(user.id, b.date)}
      current="today"
      openCount={openCount}
      footer={
        <form action={checkMeetingsNow}>
          <button className="db-nav db-nav--button" type="submit">Check meetings now</button>
        </form>
      }
    >
      <h1 className="db-title">{b.dateLabel}</h1>
      <p className="db-subtitle">
        {b.meetingCount ? `From ${n(b.meetingCount, "meeting")} today` : "No meetings yet today"} · Brief at{" "}
        <span className="db-mono">{formatBriefTime(user.briefTime)}</span>
      </p>
      <SummaryLinks />

      {conn.status === "needs_reconnect" ? (
        <p className="db-banner" role="status">
          Wispr Flow signed you out, so new meetings aren&apos;t coming in. <a href="/api/wispr/connect">Reconnect</a>
        </p>
      ) : null}
      {undo ? (
        <form action={setStatus} className="db-banner" role="status">
          {was === "wrong" ? "Removed." : "Marked done."}
          <input type="hidden" name="id" value={undo} />
          <input type="hidden" name="status" value="open" />
          <button className="db-act" type="submit">Undo</button>
        </form>
      ) : null}

      <DayRibbon ribbon={ribbon} selected={only?.id} />
      {prep ? <PrepCard prep={prep} time={formatTime(prep.meeting.startsAt, user.timeZone)} inLabel={minutesUntil(prep.meeting.startsAt, now)} nowMs={now.getTime()} /> : null}
      {only ? <MeetingChip title={only.title} time={formatTime(only.startedAt, user.timeZone)} /> : null}

      {only ? null : <CloseMoment lines={closedSinceLook} />}
      <Section title="You owe" count={only ? countOf(keep(b.youOwe)) : owedCount} empty={only ? "Nothing you owe from this meeting." : b.meetingCount ? "Nothing owed. Go home." : "Nothing owed today."}>
        {keep(b.youOwe).map((l) => <BriefItem key={l.itemId} line={l} />)}
      </Section>
      <Section title="Waiting on" count={countOf(keep(b.waitingOn))} empty={only ? "Nobody owes you anything from this meeting." : "Nobody owes you anything today."}>
        {keep(b.waitingOn).map((l) => <BriefItem key={l.itemId} line={l} />)}
      </Section>
      <Section title="Decisions" count={countOf(keep(b.decisions))} empty={only ? "No decisions in this meeting." : "No decisions today."}>
        {keep(b.decisions).map((l) => <BriefItem key={l.itemId} line={l} />)}
      </Section>
      {only ? null : b.closedToday.length ? (
        <Section title="Closed today" count={String(b.closedToday.length)}>
          {b.closedToday.map((l) => <ClosedItem key={l.itemId} line={l} />)}
        </Section>
      ) : null}
      {!only && b.stillOpenCount ? (
        <Section title="Still open" count={String(b.stillOpenCount)}>
          {b.stillOpen.map((l) => <BriefItem key={l.itemId} line={l} />)}
          {b.stillOpenCount > b.stillOpen.length ? (
            <p className="db-section__empty">
              <a className="db-link" href="/open">See all {b.stillOpenCount} still open</a>
            </p>
          ) : null}
        </Section>
      ) : null}
    </Shell>
  );
}
