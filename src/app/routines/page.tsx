import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Section } from "@/components/BriefList";
import { Shell } from "@/components/Shell";
import { NewRoutine, RoutineRow, SuggestionCard, type RoutineRowView, type SuggestionView } from "@/components/routines/RoutineRows";
import { addDays, localDate } from "@/lib/brief/time";
import { lastDone, nextDue, routineLine, streak } from "@/lib/routines/schedule";
import { cadenceLabel, relativeDay, shortDay } from "@/lib/routines/words";
import { getStore, me } from "@/server/local/app";
import { routineStore } from "@/server/routines";
import { captureContextAction } from "../capture-actions";
import { pastDays } from "../_lib/days";
import { shortDate } from "../_lib/lines";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Routines" };

// Things you do regularly, with when each is next due and when you last did it.
export default async function Routines() {
  const user = await me();
  if (!user) redirect("/setup");
  const store = getStore();
  const rs = routineStore(store);
  const tz = user.timeZone;
  const today = localDate(new Date(), tz);
  const tomorrow = addDays(today, 1);
  const openCount = (await store.listItems(user.id, { status: "open" })).filter((i) => i.kind !== "decision").length;
  const people = (await captureContextAction())?.people ?? [];

  const routines = rs ? await rs.listRoutines(user.id) : [];
  const occ = rs ? await rs.listOccurrences(user.id) : [];
  const meetingTitle = new Map<string, { title: string; startedAt: string } | null>();
  const meetingOf = async (id: string) => {
    if (!meetingTitle.has(id)) { const m = await store.getMeeting(id); meetingTitle.set(id, m ? { title: m.title, startedAt: m.startedAt } : null); }
    return meetingTitle.get(id) ?? null;
  };

  const rows: Array<RoutineRowView & { order: string }> = [];
  for (const r of routines) {
    const next = r.archived ? null : nextDue(r, occ, today, tz);
    const last = lastDone(occ, r.id);
    const overdue = r.archived ? null : routineLine(r, occ, today, tz)?.overdueLabel ?? null;
    const m = r.source.type === "meeting" ? await meetingOf(r.source.meetingId) : null;
    rows.push({
      id: r.id, title: r.title, cadence: r.cadence, time: r.time, person: r.person, archived: r.archived,
      label: cadenceLabel(r.cadence, r.time),
      next: next ? relativeDay(next, today, tomorrow) : null,
      overdue: overdue ? overdue[0].toUpperCase() + overdue.slice(1) : null,
      order: overdue ? `0${r.title}` : `1${next ?? "9999"}${r.title}`,
      lastDone: last ? (last === today ? "today" : shortDay(last)) : null,
      streak: streak(r, occ, today, tz),
      fromMeeting: r.source.type === "meeting" && m ? { id: r.source.meetingId, title: m.title } : null,
    });
  }
  // Overdue first, then by when each is next due.
  const active = rows.filter((r) => !r.archived).sort((a, b) => a.order.localeCompare(b.order));
  const archived = rows.filter((r) => r.archived);

  const suggestions: SuggestionView[] = [];
  for (const s of rs ? await rs.listRoutineSuggestions(user.id) : []) {
    if (s.status !== "open") continue;
    const m = await meetingOf(s.meetingId);
    suggestions.push({
      id: s.id, title: s.title, cadence: s.cadence, time: s.time, person: s.person, label: cadenceLabel(s.cadence, s.time), quote: s.quote,
      meeting: m ? { id: s.meetingId, title: m.title, when: shortDate(m.startedAt, tz) } : null,
    });
  }

  return (
    <Shell days={await pastDays(user.id, "")} current="routines" openCount={openCount}>
      <h1 className="db-title">Routines</h1>
      <p className="db-subtitle">
        {rs ? "Things you do regularly. Each one shows on Today when it's due; ticking it closes that day only." : "Routines aren't available in the hosted version yet."}
      </p>
      {rs ? (
        <>
          {suggestions.length ? (
            <Section title="Suggested from your meetings" count={String(suggestions.length)}>
              {suggestions.map((s) => <SuggestionCard key={s.id} s={s} today={today} people={people} />)}
            </Section>
          ) : null}
          <Section title="Your routines" count={active.length ? String(active.length) : undefined} empty="None yet. Add one below, or type “every Monday send the report to Tarun” in quick add (c).">
            {active.map((r) => <RoutineRow key={r.id} r={r} today={today} people={people} />)}
          </Section>
          <div className="rt-add"><NewRoutine today={today} people={people} startOpen={!routines.length} /></div>
          {archived.length ? (
            <details className="rt-archived">
              <summary>Archived ({archived.length})</summary>
              {archived.map((r) => <RoutineRow key={r.id} r={r} today={today} people={people} />)}
            </details>
          ) : null}
        </>
      ) : null}
    </Shell>
  );
}
