import type { BriefLine, BriefModel, ClosedLine, Item, Meeting, User } from "@/lib/types";
import type { Store } from "@/server/store";
import { dateLabel, dueLabel, formatTime, lateLabel, localDate, localDayBounds } from "./time";

const STILL_OPEN_SHOWN = 5;

/**
 * Builds the structured brief for the user's local "today" at `now`.
 * Pure apart from reads through `store`; rendering lives in markdown.ts and email/render.ts.
 */
export async function buildBrief(store: Store, user: User, now: Date): Promise<BriefModel> {
  const tz = user.timeZone;
  const date = localDate(now, tz);
  const { startIso, endIso } = localDayBounds(date, tz);
  const inToday = (iso: string | null) => !!iso && iso >= startIso && iso < endIso;

  const todaysMeetings = (await store.listMeetingsBetween(user.id, startIso, endIso)).filter((m) => m.processedAt);
  const items = (await store.listItems(user.id)).filter((i) => i.status !== "wrong");

  const meetingCache = new Map<string, Meeting | null>();
  for (const m of todaysMeetings) meetingCache.set(m.id, m);
  const meetingOf = async (id: string | null) => {
    if (!id) return null;
    if (!meetingCache.has(id)) meetingCache.set(id, await store.getMeeting(id));
    return meetingCache.get(id) ?? null;
  };

  const toLine = async (i: Item): Promise<BriefLine> => {
    const m = await meetingOf(i.meetingId);
    const lateMinutes = i.status === "open" && i.dueAt && Date.parse(i.dueAt) < now.getTime()
      ? Math.floor((now.getTime() - Date.parse(i.dueAt)) / 60000) : null;
    return {
      itemId: i.id, kind: i.kind, text: i.text, person: i.person, quote: i.quote,
      meetingTitle: m?.title ?? "a meeting",
      meetingTime: m ? formatTime(m.startedAt, tz) : "",
      dueLabel: i.dueAt && lateMinutes === null ? dueLabel(i.dueAt, now, tz) : null,
      lateMinutes,
      lateLabel: lateMinutes !== null ? lateLabel(lateMinutes) : null,
    };
  };

  const fromToday = async (i: Item) => inToday((await meetingOf(i.meetingId))?.startedAt ?? null);
  const dueSoon = (i: Item) => !!i.dueAt && Date.parse(i.dueAt) < Date.parse(endIso) + 86400000; // due by end of tomorrow (or overdue)

  const open = items.filter((i) => i.status === "open");
  const shown = new Set<string>();
  const pick = async (kind: Item["kind"]) => {
    const out: Item[] = [];
    for (const i of open.filter((x) => x.kind === kind)) if ((await fromToday(i)) || dueSoon(i)) out.push(i);
    out.forEach((i) => shown.add(i.id));
    return out;
  };

  const owe = await Promise.all((await pick("owe")).map(toLine));
  owe.sort((a, b) =>
    (b.lateMinutes ?? -1) - (a.lateMinutes ?? -1) ||
    order(items, a.itemId) - order(items, b.itemId));
  const waiting = await Promise.all((await pick("waiting")).map(toLine));
  waiting.sort((a, b) => order(items, a.itemId) - order(items, b.itemId));

  const decisionItems: Item[] = [];
  for (const i of items.filter((x) => x.kind === "decision")) if (await fromToday(i)) decisionItems.push(i);
  const decisions = await Promise.all(decisionItems.map(toLine));

  const closedToday: ClosedLine[] = [];
  for (const i of items.filter((x) => x.status === "done" && inToday(x.closedAt) && x.closeQuote)) {
    const m = await meetingOf(i.closedByMeetingId);
    closedToday.push({
      itemId: i.id, text: i.text, closeQuote: i.closeQuote!,
      closedInMeeting: m?.title ?? "a meeting", closedAtTime: m ? formatTime(m.startedAt, tz) : "",
    });
  }

  const rest = open.filter((i) => !shown.has(i.id) && i.kind !== "decision")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const stillOpen = await Promise.all(rest.slice(0, STILL_OPEN_SHOWN).map(toLine));

  const madeToday: Item[] = [];
  for (const i of items.filter((x) => x.kind === "owe")) if (await fromToday(i)) madeToday.push(i);
  const kept = items.filter((i) => i.kind === "owe" && i.status === "done" && inToday(i.closedAt)).length;
  const late = owe.filter((l) => l.lateMinutes !== null).length;

  const wrap = { meetings: todaysMeetings.length, made: madeToday.length, kept, late };
  const empty: BriefModel["empty"] = todaysMeetings.length === 0 ? "no_meetings" : owe.length === 0 ? "nothing_owed" : null;

  return {
    userId: user.id, date, dateLabel: dateLabel(date), meetingCount: todaysMeetings.length,
    wrap, youOwe: owe, waitingOn: waiting, decisions, closedToday,
    stillOpenCount: rest.length, stillOpen, empty,
    subject: subjectFor({ owe: owe.length, late, waiting: waiting.length, decisions: decisions.length, meetings: todaysMeetings.length, stillOpen: rest.length + owe.length + waiting.length }),
  };
}

function order(items: Item[], id: string): number {
  const i = items.find((x) => x.id === id)!;
  return i.dueAt ? Date.parse(i.dueAt) : Number.MAX_SAFE_INTEGER - Date.parse(i.createdAt) / 1e6;
}

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

export function subjectFor(c: { owe: number; late: number; waiting: number; decisions: number; meetings: number; stillOpen: number }): string {
  if (c.meetings === 0) return c.stillOpen ? `Your day: no meetings, ${c.stillOpen} still open` : "Your day: no meetings, nothing open";
  const parts: string[] = [];
  if (c.late) parts.push(`${c.late} overdue`);
  if (c.owe - c.late) parts.push(`${c.owe - c.late} owed`);
  if (c.waiting) parts.push(`${c.waiting} waiting`);
  if (c.decisions) parts.push(plural(c.decisions, "decision"));
  return parts.length ? `Your day: ${parts.join(", ")}` : "Your day: nothing owed";
}
