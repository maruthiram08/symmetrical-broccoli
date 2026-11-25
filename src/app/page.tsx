import { redirect } from "next/navigation";
import { BriefItem, ClosedItem, Section } from "@/components/BriefList";
import { Shell } from "@/components/Shell";
import { buildBrief } from "@/lib/brief/build";
import { getStore, me } from "@/server/local/app";
import { checkMeetingsNow, setStatus } from "./actions";
import { formatBriefTime } from "./_lib/time";
import { pastDays } from "./_lib/days";

export const dynamic = "force-dynamic";

export default async function Today({ searchParams }: { searchParams: Promise<{ undo?: string; was?: string }> }) {
  const user = await me();
  if (!user) redirect("/setup");
  const store = getStore();
  const conn = await store.getConnection(user.id);
  if (!conn) redirect("/setup");

  const b = await buildBrief(store, user, new Date());
  const { undo, was } = await searchParams;
  const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;
  const owedCount = b.youOwe.length ? `${b.youOwe.length}${b.wrap.late ? ` · ${b.wrap.late} late` : ""}` : undefined;

  return (
    <Shell
      days={await pastDays(user.id, b.date)}
      current="today"
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

      <Section title="You owe" count={owedCount} empty={b.meetingCount ? "Nothing owed. Go home." : "Nothing owed today."}>
        {b.youOwe.map((l) => <BriefItem key={l.itemId} line={l} />)}
      </Section>
      <Section title="Waiting on" count={b.waitingOn.length ? String(b.waitingOn.length) : undefined} empty="Nobody owes you anything today.">
        {b.waitingOn.map((l) => <BriefItem key={l.itemId} line={l} />)}
      </Section>
      <Section title="Decisions" count={b.decisions.length ? String(b.decisions.length) : undefined} empty="No decisions today.">
        {b.decisions.map((l) => <BriefItem key={l.itemId} line={l} />)}
      </Section>
      {b.closedToday.length ? (
        <Section title="Closed today" count={String(b.closedToday.length)}>
          {b.closedToday.map((l) => <ClosedItem key={l.itemId} line={l} />)}
        </Section>
      ) : null}
      {b.stillOpenCount ? (
        <Section title="Still open" count={String(b.stillOpenCount)}>
          {b.stillOpen.map((l) => <BriefItem key={l.itemId} line={l} />)}
          {b.stillOpenCount > b.stillOpen.length ? <p className="db-section__empty">And {b.stillOpenCount - b.stillOpen.length} more from earlier.</p> : null}
        </Section>
      ) : null}
    </Shell>
  );
}
