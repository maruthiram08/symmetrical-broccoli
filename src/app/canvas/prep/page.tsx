import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Board } from "@/components/canvas/Board";
import { buildPrep, others, PREP_MEETINGS, type PrepTarget } from "@/lib/canvas/build";
import { findSlots } from "@/lib/canvas/recurring";
import { normTitle } from "@/lib/calendar/series";
import { getStore, me } from "@/server/local/app";
import { canvasCtx } from "@/server/canvas/data";
import { CanvasFrame } from "../_shared";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Meeting prep" };

type Q = { slot?: string; person?: string; upcoming?: string };

export default async function PrepPage({ searchParams }: { searchParams: Promise<Q> }) {
  const user = await me();
  if (!user) redirect("/setup");
  const q = await searchParams;
  const c = await canvasCtx(user);
  const past = c.meetings.filter((m) => !m.duplicateOf && Date.parse(m.startedAt) <= c.now.getTime()).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  let t: PrepTarget | null = null;

  if (q.slot) {
    const s = findSlots(c.meetings, c.now, user.timeZone).find((x) => x.key === q.slot);
    if (s) {
      const seen = new Map<string, number>();
      for (const m of s.meetings.slice(0, 5)) for (const p of others(m, c.self)) seen.set(p, (seen.get(p) ?? 0) + 1);
      t = { key: `slot:${s.key}`, title: `your ${s.label} meeting`, at: s.next, meetings: s.meetings.slice(0, PREP_MEETINGS), people: [...seen].filter(([, n]) => n >= 2).map(([p]) => p).slice(0, 6) };
    }
  } else if (q.person) {
    const name = q.person.slice(0, 80);
    const first = name.toLowerCase().split(/\s+/)[0];
    const withThem = past.filter((m) => others(m, c.self).some((p) => p.toLowerCase().split(/\s+/)[0] === first) || c.items.some((i) => i.meetingId === m.id && i.person?.toLowerCase().split(/\s+/)[0] === first));
    t = { key: `person:${name.toLowerCase()}`, title: name, at: null, meetings: withThem.slice(0, PREP_MEETINGS), people: [name] };
  } else if (q.upcoming) {
    const u = ((await getStore().getUpcoming(user.id))?.meetings ?? []).find((x) => x.calendarId === q.upcoming);
    if (u) {
      const att = new Set(u.attendees.map((a) => a.toLowerCase()));
      const same = past.filter((m) => normTitle(m.title) === normTitle(u.title) || others(m, c.self).some((p) => att.has(p.toLowerCase())));
      t = { key: `upcoming:${u.calendarId}`, title: u.title, at: u.startsAt, meetings: same.slice(0, PREP_MEETINGS), people: u.attendees.filter((a) => !c.self.some((s) => s.toLowerCase() === a.toLowerCase())) };
    }
  }
  if (!t) redirect("/canvas");
  const doc = buildPrep(t, c);
  return (
    <CanvasFrame board="prep" title={doc.title} sub="Lime lines are what Ask reads. Click “In context” on a card to leave it out.">
      {doc.empty ? <p className="cv-empty">{doc.empty}</p> : <Board doc={doc} />}
    </CanvasFrame>
  );
}
