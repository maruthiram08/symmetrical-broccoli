import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { Detail, DetailBar, Head, Kv, LinkGroups, ListBar, NoneDetail, RailCard, Sec, type LinkGroup } from "@/components/reading/Frame";
import { NewRoutine, RoutineRow, SuggestionCard, type RoutineRowView, type SuggestionView } from "@/components/routines/RoutineRows";
import { addDays, localDate } from "@/lib/brief/time";
import { lastDone, nextDue, routineLine, streak } from "@/lib/routines/schedule";
import { cadenceLabel, relativeDay, shortDay } from "@/lib/routines/words";
import { getStore, me } from "@/server/local/app";
import { routineStore } from "@/server/routines";
import { captureContextAction } from "../capture-actions";
import { shortDate } from "../_lib/lines";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Routines" };

// Things you do regularly, with when each is next due and when you last did it.
export default async function Routines({ searchParams }: { searchParams: Promise<{ r?: string; s?: string; new?: string }> }) {
  const q = await searchParams;
  const user = await me();
  if (!user) redirect("/setup");
  const store = getStore();
  const rs = routineStore(store);
  const tz = user.timeZone;
  const today = localDate(new Date(), tz);
  const tomorrow = addDays(today, 1);
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

  const plus = (
    <a className="rp-ico" href="/routines?new=1" aria-label="New routine" title="New routine">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
    </a>
  );
  const groups: LinkGroup[] = [
    ...(suggestions.length ? [{ key: "suggested", label: "Suggested from your meetings", rows: suggestions.map((x) => ({ key: `s:${x.id}`, href: `/routines?s=${encodeURIComponent(x.id)}`, title: x.title, sub: `${x.label}${x.person ? ` · ${x.person}` : ""}`, badge: "Suggested", mark: "ring" })) }] : []),
    { key: "yours", label: "Your routines", rows: active.map((r) => ({ key: `r:${r.id}`, href: `/routines?r=${encodeURIComponent(r.id)}`, title: r.title, sub: [r.label, r.next ? `next ${r.next}` : ""].filter(Boolean).join(" · "), badge: r.overdue ? "Overdue" : r.streak > 1 ? `${r.streak} in a row` : "", late: !!r.overdue, mark: r.overdue ? "late" : "ring" })), empty: "Nothing yet. Turn on a suggestion, or press + to make your own." },
    ...(archived.length ? [{ key: "archived", label: "Archived", rows: archived.map((r) => ({ key: `r:${r.id}`, href: `/routines?r=${encodeURIComponent(r.id)}`, title: r.title, sub: r.label, mark: "dot" })) }] : []),
  ];
  const all = groups.flatMap((g) => g.rows);
  const want = q.new ? "new" : q.r ? `r:${q.r}` : q.s ? `s:${q.s}` : null;
  const sel = want === "new" ? "new" : (want && all.some((x) => x.key === want) ? want : all[0]?.key ?? (rs ? "new" : null));
  const list = (
    <>
      <ListBar title="Routines" count={active.length ? `${active.length} on` : "None on yet"}>{rs ? plus : null}</ListBar>
      {rs ? <LinkGroups groups={groups} sel={sel} /> : <p className="rp-quiet rp-quiet--pad">Routines aren&apos;t available in the hosted version yet.</p>}
    </>
  );
  const pos = sel ? all.findIndex((x) => x.key === sel) + 1 : 0;
  const bar = (label: string) => <DetailBar crumb={[{ label: "Routines", href: "/routines" }, { label }]} listHref="/routines" acts={pos ? <span className="rp-pos">{pos} of {all.length}</span> : null} />;
  const note = <RailCard title="Only on this Mac">Routines show on Today when they&apos;re due. Ticking one closes that day only. Nothing is sent to anyone.</RailCard>;
  let detail;
  const sug = sel?.startsWith("s:") ? suggestions.find((x) => `s:${x.id}` === sel) : null;
  const rt = sel?.startsWith("r:") ? rows.find((x) => `r:${x.id}` === sel) : null;
  if (sel === "new") {
    detail = (
      <Detail bar={bar("New routine")} rail={note}>
        <Head kind="New routine" mark="ring" title="Something you do regularly" lede={<>Or type &ldquo;every Monday send the report to Tarun&rdquo; in quick add (c).</>} />
        <NewRoutine today={today} people={people} startOpen />
      </Detail>
    );
  } else if (sug) {
    detail = (
      <Detail bar={bar("Suggested")} rail={<>
        <Sec title="Details"><Kv rows={[["When", sug.label], sug.person ? ["For", sug.person] : null, sug.meeting ? ["Heard in", <a key="m" href={`/meeting/${encodeURIComponent(sug.meeting.id)}`}>{sug.meeting.title}</a>] : null, sug.meeting ? ["On", sug.meeting.when] : null, ["Status", "Off"]]} /></Sec>
        {note}
      </>}>
        <Head kind="Suggested routine" mark="ring" st={sug.meeting ? [{ text: `From ${sug.meeting.when}` }] : undefined} title={sug.title} lede={sug.quote ? <>&ldquo;{sug.quote}&rdquo;</> : undefined} />
        <Sec title="Turn it on"><SuggestionCard s={sug} today={today} people={people} /></Sec>
      </Detail>
    );
  } else if (rt) {
    detail = (
      <Detail bar={bar(rt.archived ? "Archived" : "Your routine")} rail={<>
        <Sec title="Details"><Kv rows={[["When", rt.label], rt.person ? ["For", rt.person] : null, ["Next", rt.archived ? "Archived" : rt.next ?? "—"], ["Last done", rt.lastDone ?? "Not yet"], rt.streak > 1 ? ["Streak", `${rt.streak} in a row`] : null, rt.fromMeeting ? ["From", <a key="m" href={`/meeting/${encodeURIComponent(rt.fromMeeting.id)}`}>{rt.fromMeeting.title}</a>] : null]} /></Sec>
        {note}
      </>}>
        <Head kind="Routine" mark={rt.overdue ? "late" : "ring"} st={rt.overdue ? [{ text: rt.overdue, late: true }] : rt.archived ? [{ text: "Archived" }] : undefined} title={rt.title} lede={rt.label} />
        <Sec title="Change it"><RoutineRow r={rt} today={today} people={people} /></Sec>
      </Detail>
    );
  } else {
    detail = <NoneDetail crumb={[{ label: "Routines" }]} listHref="/routines" text="Nothing picked." />;
  }
  return <Shell current="routines" list={list} detail={detail} show={want ? "detail" : "list"} />;
}
