import { redirect } from "next/navigation";
import { Section } from "@/components/BriefList";
import { DecisionRow, PersonRow, StaleRow, Stats, SummaryLinks } from "@/components/CloseWrap";
import { Shell } from "@/components/Shell";
import { loadBriefData } from "@/lib/brief/data";
import { localDate } from "@/lib/brief/time";
import { buildWeek, STALE_DAYS } from "@/lib/brief/week";
import { getStore, me } from "@/server/local/app";
import { formatBriefTime } from "../_lib/time";
import { pastDays } from "../_lib/days";

export const dynamic = "force-dynamic";

// This week so far. Friday's brief also saves it as week-YYYY-Www.md.
export default async function Week() {
  const user = await me();
  if (!user) redirect("/setup");
  const store = getStore();
  const now = new Date();
  const w = buildWeek(await loadBriefData(store, user.id), now, user.timeZone);

  return (
    <Shell days={await pastDays(user.id, localDate(now, user.timeZone))} current="week">
      <h1 className="db-title">This week</h1>
      <p className="db-subtitle">
        {w.label} · Saved as <span className="db-mono">week-{w.key}.md</span> with Friday&apos;s brief at{" "}
        <span className="db-mono">{formatBriefTime(user.briefTime)}</span>
      </p>
      <SummaryLinks current="week" />

      <Stats items={[
        { label: "Meetings", value: w.counts.meetings },
        { label: "Promises made", value: w.counts.made },
        { label: "Kept", value: w.counts.kept },
        { label: "Late", value: w.counts.late, late: true },
      ]} />
      <Section title="People you owe" empty="You don't owe anyone this week.">
        {w.youOwe.map((p) => <PersonRow key={p.person} p={p} />)}
      </Section>
      <Section title="People who owe you" empty="Nobody owes you anything this week.">
        {w.oweYou.map((p) => <PersonRow key={p.person} p={p} />)}
      </Section>
      <Section title="Decisions" count={w.decisions.length ? String(w.decisions.length) : undefined} empty="No decisions this week.">
        {w.decisions.map((d) => <DecisionRow key={d.itemId} d={d} />)}
      </Section>
      <Section title={`Open more than ${STALE_DAYS} days`} count={w.stale.length ? String(w.stale.length) : undefined} empty={`Nothing has been open more than ${STALE_DAYS} days.`}>
        {w.stale.map((s) => <StaleRow key={s.itemId} s={s} />)}
      </Section>
    </Shell>
  );
}
