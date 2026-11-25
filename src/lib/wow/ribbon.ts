// Day ribbon: today's meetings on one line, each marked by what it produced. Pure.

import { formatTime, localDayBounds, offsetMinutes } from "@/lib/brief/time";
import type { Item, Meeting } from "@/lib/types";

export interface RibbonMeeting {
  id: string;
  title: string;
  /** "11:00 AM" in the user's zone. */
  time: string;
  /** Position on the ribbon, 0..1. */
  at: number;
  owe: number;
  waiting: number;
  decisions: number;
  total: number;
  /** Not read yet: shown hollow. */
  pending: boolean;
}

export interface Ribbon {
  /** First and last hour shown (local, 0..24). */
  fromHour: number;
  toHour: number;
  /** Hour ticks to label, local hours. */
  ticks: Array<{ hour: number; at: number; label: string }>;
  /** Where "now" falls, 0..1, or null when now is off the ribbon. */
  now: number | null;
  meetings: RibbonMeeting[];
}

/** Local hour (fractional) of an instant. */
function localHour(iso: string, timeZone: string): number {
  const d = new Date(iso);
  const mins = (d.getUTCHours() * 60 + d.getUTCMinutes() + offsetMinutes(d, timeZone) + 1440) % 1440;
  return mins / 60;
}

const hourLabel = (h: number) => (h === 0 || h === 24 ? "12a" : h === 12 ? "12p" : h < 12 ? `${h}a` : `${h - 12}p`);

/**
 * Group the day's items by the meeting they came from and lay the meetings out between 9 and 6
 * (widened to fit early or late meetings). Items marked wrong are not counted.
 */
export function buildRibbon(args: { date: string; timeZone: string; meetings: Meeting[]; items: Item[]; now: Date }): Ribbon {
  const { date, timeZone, now } = args;
  const { startIso, endIso } = localDayBounds(date, timeZone);
  const meetings = args.meetings
    .filter((m) => m.startedAt >= startIso && m.startedAt < endIso)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  const counts = new Map<string, { owe: number; waiting: number; decisions: number }>();
  for (const i of args.items) {
    if (i.status === "wrong") continue;
    const c = counts.get(i.meetingId) ?? { owe: 0, waiting: 0, decisions: 0 };
    if (i.kind === "owe") c.owe++;
    else if (i.kind === "waiting") c.waiting++;
    else c.decisions++;
    counts.set(i.meetingId, c);
  }

  const hours = meetings.map((m) => localHour(m.startedAt, timeZone));
  const fromHour = Math.min(9, ...hours.map(Math.floor));
  const toHour = Math.max(18, ...hours.map((h) => Math.floor(h) + 1));
  const span = toHour - fromHour;
  const pos = (h: number) => Math.min(1, Math.max(0, (h - fromHour) / span));

  const step = span > 12 ? 4 : 3;
  const ticks: Ribbon["ticks"] = [];
  for (let h = Math.ceil(fromHour / step) * step; h <= toHour; h += step) ticks.push({ hour: h, at: pos(h), label: hourLabel(h) });

  const nowIso = now.toISOString();
  const nowHour = localHour(nowIso, timeZone);
  const onRibbon = nowIso >= startIso && nowIso < endIso && nowHour >= fromHour && nowHour <= toHour;

  return {
    fromHour, toHour, ticks,
    now: onRibbon ? pos(nowHour) : null,
    meetings: meetings.map((m, k) => {
      const c = counts.get(m.id) ?? { owe: 0, waiting: 0, decisions: 0 };
      return {
        id: m.id, title: m.title, time: formatTime(m.startedAt, timeZone), at: pos(hours[k]),
        ...c, total: c.owe + c.waiting + c.decisions, pending: !m.processedAt,
      };
    }),
  };
}
