import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { BriefItem, ClosedItem, Section } from "@/components/BriefList";
import { DayNotes } from "@/components/DayNotes";
import { Shell } from "@/components/Shell";
import { buildBrief } from "@/lib/brief/build";
import { getStore, me } from "@/server/local/app";
import { readDayNote } from "@/server/local/notes";
import { openCountFor, pastDays } from "../_lib/days";
import { editorContext } from "../_lib/editor";
import { formatBriefTime } from "../_lib/time";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Today view" };

const countOf = (l: unknown[]) => (l.length ? String(l.length) : undefined);

// The Today view: today's brief and today's note side by side on wide screens, stacked on narrow ones.
export default async function TodayView() {
  const user = await me();
  if (!user) redirect("/welcome");
  const now = new Date();
  const store = getStore();
  const b = await buildBrief(store, user, now);
  const ctx = await editorContext(user, now);
  const note = await readDayNote(user.id, b.date);
  return (
    <Shell days={await pastDays(user.id, b.date)} current="today" openCount={await openCountFor(user.id)} wide>
      <h1 className="db-title">{b.dateLabel}</h1>
      <p className="db-subtitle">
        {b.meetingCount ? `From ${b.meetingCount} meeting${b.meetingCount === 1 ? "" : "s"} today` : "No meetings yet today"} · Brief at{" "}
        <span className="db-mono">{formatBriefTime(user.briefTime)}</span> · <Link className="db-link" href="/">Just the brief</Link>
      </p>
      <div className="db-todayview">
        <div className="db-todayview__brief">
          <Section title="You owe" count={countOf(b.youOwe)} empty="Nothing owed today.">
            {b.youOwe.map((l) => <BriefItem key={l.itemId} line={l} back="/today" />)}
          </Section>
          <Section title="Waiting on" count={countOf(b.waitingOn)} empty="Nobody owes you anything today.">
            {b.waitingOn.map((l) => <BriefItem key={l.itemId} line={l} back="/today" />)}
          </Section>
          <Section title="Decisions" count={countOf(b.decisions)} empty="No decisions today.">
            {b.decisions.map((l) => <BriefItem key={l.itemId} line={l} back="/today" />)}
          </Section>
          {b.closedToday.length ? (
            <Section title="Closed today" count={String(b.closedToday.length)}>
              {b.closedToday.map((l) => <ClosedItem key={l.itemId} line={l} />)}
            </Section>
          ) : null}
        </div>
        <div className="db-todayview__note">
          <DayNotes date={b.date} initial={note?.notes ?? ""} title="Today's note" {...ctx} />
        </div>
      </div>
    </Shell>
  );
}
