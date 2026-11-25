// Tomorrow at a glance: tomorrow's meetings, each with what's open with its people. Pure.

import { addDays, dueLabel, formatTime, lateLabel, localDayBounds } from "@/lib/brief/time";
import { prepFor } from "@/lib/wow/prep";
import type { CalendarEvent, GlanceItem, GlanceMeeting, Item, MeetingSeries } from "@/lib/types";
import { seriesOfEvent } from "./series";

/** Same as brief/markdown.ts esc (not imported: markdown.ts imports this file). */
const esc = (s: string) => s.replace(/\r?\n+/g, " ").replace(/([\\`*_[\]<>#|~])/g, "\\$1");

/** Tomorrow's events (in the user's zone, the day after `today`), soonest first, with open items. */
export function tomorrowGlance(args: {
  events: CalendarEvent[];
  items: Item[];
  series?: MeetingSeries[];
  today: string;
  timeZone: string;
  now: Date;
  self?: string[];
}): GlanceMeeting[] {
  const { startIso, endIso } = localDayBounds(addDays(args.today, 1), args.timeZone);
  const open = args.items.filter((i) => i.status === "open");
  const item = (i: Item): GlanceItem => {
    const late = !!i.dueAt && Date.parse(i.dueAt) < args.now.getTime();
    return {
      itemId: i.id, text: i.text, person: i.person, late,
      when: !i.dueAt ? null : late ? lateLabel(Math.floor((args.now.getTime() - Date.parse(i.dueAt)) / 60000)) : dueLabel(i.dueAt, args.now, args.timeZone),
    };
  };
  const preps = args.events
    .filter((e) => e.startsAt >= startIso && e.startsAt < endIso)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
    .map((e) => ({ e, p: prepFor({ calendarId: e.calendarId, title: e.title, startsAt: e.startsAt, attendees: e.attendees }, open, args.self ?? []) }));
  // Each item is listed once: under the smallest meeting with its person (a 1:1 before a standup), then the earliest.
  const home = new Map<string, number>();
  preps.forEach(({ p }, k) => {
    for (const i of [...p.owe, ...p.waiting]) {
      const h = home.get(i.id);
      if (h === undefined || p.people.length < preps[h].p.people.length) home.set(i.id, k);
    }
  });
  return preps.map(({ e, p }, k) => {
    const mine = (i: Item) => home.get(i.id) === k;
    const elsewhere = [...p.owe, ...p.waiting].filter((i) => !mine(i));
    return {
      calendarId: e.calendarId, title: e.title, startsAt: e.startsAt, time: formatTime(e.startsAt, args.timeZone),
      people: p.people, seriesId: seriesOfEvent(e, args.series ?? [])?.id ?? null,
      owe: p.owe.filter(mine).map(item), waiting: p.waiting.filter(mine).map(item),
      alsoOpen: elsewhere.length,
      alsoIn: [...new Set(elsewhere.map((i) => preps[home.get(i.id)!].e.title))],
    };
  });
}

/** "4 more with them, under Launch sync and Design crit" */
export function alsoLabel(m: Pick<GlanceMeeting, "alsoOpen" | "alsoIn">): string | null {
  if (!m.alsoOpen) return null;
  const where = m.alsoIn.length > 1 ? `${m.alsoIn.slice(0, -1).join(", ")} and ${m.alsoIn[m.alsoIn.length - 1]}` : m.alsoIn[0];
  return `${m.alsoOpen} more with them, under ${where}`;
}

/** The daily note's "## Tomorrow at a glance" section. Nothing when the calendar was never read. */
export function renderTomorrowSection(tomorrow: GlanceMeeting[] | undefined): string[] {
  if (!tomorrow) return [];
  const out = ["## Tomorrow at a glance", ""];
  if (!tomorrow.length) return [...out, "No meetings tomorrow.", ""];
  for (const m of tomorrow) {
    out.push(`- ${m.time} · ${esc(m.title)}${m.people.length ? ` (with ${m.people.map(esc).join(", ")})` : ""}`);
    const when = (g: GlanceItem) => (g.when ? (g.late ? ` **(${g.when})**` : ` (${g.when})`) : "");
    for (const g of m.owe) out.push(`  - [ ] You owe${g.person ? ` ${esc(g.person)}` : ""}: ${esc(g.text)}${when(g)}`);
    for (const g of m.waiting) out.push(`  - [ ] Waiting on${g.person ? ` ${esc(g.person)}` : ""}: ${esc(g.text)}${when(g)}`);
    const also = alsoLabel(m);
    if (also) out.push(`  - ${esc(also)}`);
  }
  out.push("");
  return out;
}
