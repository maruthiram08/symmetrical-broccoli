import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Section } from "@/components/BriefList";
import { CloseRow, PromiseRow, Stats, SummaryLinks } from "@/components/CloseWrap";
import { Shell } from "@/components/Shell";
import { loadBriefData } from "@/lib/brief/data";
import { formatTime } from "@/lib/brief/time";
import { buildWrap } from "@/lib/brief/wrap";
import { getStore, me } from "@/server/local/app";
import { formatBriefTime, nextBriefDay } from "../_lib/time";
import { openCountFor, pastDays } from "../_lib/days";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Wrap" };

// Evening wrap: how the day went. The same numbers go in the daily note's "## Wrap" section.
export default async function Wrap() {
  const user = await me();
  if (!user) redirect("/setup");
  const store = getStore();
  const now = new Date();
  const w = buildWrap(await loadBriefData(store, user.id), now, user.timeZone);
  const beforeBrief = nextBriefDay(user.briefTime, user.timeZone, now) === "today";

  return (
    <Shell days={await pastDays(user.id, w.date)} current="wrap" openCount={await openCountFor(user.id)}>
      <h1 className="db-title">Wrap</h1>
      <p className="db-subtitle">
        {w.dateLabel} · {beforeBrief ? "So far, as of " : "As of "}
        <span className="db-mono">{formatTime(now.toISOString(), user.timeZone)}</span>
        {beforeBrief ? <> · Brief at <span className="db-mono">{formatBriefTime(user.briefTime)}</span></> : null}
      </p>
      <SummaryLinks current="wrap" />

      {w.empty ? (
        <p className="cw-empty">Nothing owed. Go home.</p>
      ) : (
        <>
          <Stats items={[
            { label: "Meetings", value: w.counts.meetings },
            { label: "Promises made", value: w.counts.made },
            { label: "Kept", value: w.counts.kept },
            { label: "Late", value: w.counts.late, late: true },
            { label: "Still open", value: w.counts.open },
          ]} />
          <Section title="Promised today" count={w.promises.length ? String(w.promises.length) : undefined} empty="No new promises today.">
            {w.promises.map((p) => <PromiseRow key={p.itemId} p={p} />)}
          </Section>
          <Section title="Closed today" count={w.closes.length ? String(w.closes.length) : undefined} empty="Nothing closed today.">
            {w.closes.map((c) => <CloseRow key={c.itemId} c={c} />)}
          </Section>
        </>
      )}
    </Shell>
  );
}
