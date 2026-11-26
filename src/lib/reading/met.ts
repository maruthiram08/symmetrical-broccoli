// People, by how often you've met since you promised them something. "Met" means a meeting where an
// item names them (resolved through the directory and aliases): Wispr Flow sends no attendee lists,
// so a call where nothing was said about them doesn't count. An item was said on its meeting's date.
import { localDate } from "@/lib/brief/time";
import { groupNames, ownsItem, type PeopleInput, type PersonGroup } from "@/lib/people";
import type { Item, Meeting } from "@/lib/types";

const DAY = 86_400_000;
export const QUIET_DAYS = 14;
export const OLD_DAYS = 21;
/** Red once you've met this many times since without closing it. */
export const MANY_SINCE = 5;

export type MetGroup = "since" | "quiet" | "week";

export interface MetPerson {
  person: PersonGroup;
  /** Open owe and waiting items, oldest said first. */
  open: Item[];
  /** Every live item that names them. */
  items: Item[];
  /** Meetings with them, oldest first. */
  met: Meeting[];
  /** Meetings with them after the oldest open item's meeting. */
  sinceOldest: number;
  lastMet: string | null;
  /** When the oldest open item was said, ISO. */
  oldestAt: string;
  ageDays: number;
  /** Any open item past due. */
  overdue: boolean;
  group: MetGroup;
}

const live = (i: Item) => i.status !== "wrong" && i.status !== "inbox";
const isOpen = (i: Item) => i.status === "open" && i.kind !== "decision";

/** Meetings with them dated after the item's own meeting (distinct, by start time). */
export function meetingsSince(item: Item, met: Meeting[], byId: Map<string, Meeting>): Meeting[] {
  const at = byId.get(item.meetingId)?.startedAt ?? item.createdAt;
  return met.filter((m) => m.startedAt > at && m.id !== item.meetingId);
}

export function metPerson(g: PersonGroup, input: PeopleInput, timeZone: string): MetPerson | null {
  const { items, meetings, now } = input;
  const byId = new Map(meetings.filter((m) => !m.duplicateOf).map((m) => [m.id, m]));
  const mine = items.filter((i) => live(i) && ownsItem(g, i));
  const ids = new Set(mine.map((i) => i.meetingId));
  const met = [...byId.values()].filter((m) => ids.has(m.id)).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const said = (i: Item) => byId.get(i.meetingId)?.startedAt ?? i.createdAt;
  const open = mine.filter(isOpen).sort((a, b) => said(a).localeCompare(said(b)));
  if (!open.length) return null;
  const oldestAt = said(open[0]);
  const sinceOldest = meetingsSince(open[0], met, byId).length;
  const lastMet = met[met.length - 1]?.startedAt ?? null;
  const today = localDate(now, timeZone);
  const days = (iso: string) => Math.max(0, Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${localDate(new Date(iso), timeZone)}T12:00:00Z`)) / DAY));
  const group: MetGroup = sinceOldest > 0 ? "since" : lastMet && days(lastMet) >= QUIET_DAYS ? "quiet" : "week";
  return {
    person: g, open, items: mine, met, sinceOldest, lastMet, oldestAt, ageDays: days(oldestAt),
    overdue: open.some((i) => i.dueAt && Date.parse(i.dueAt) < now.getTime()), group,
  };
}

/** Everyone with something open, in Met since (most meetings since first), Gone quiet and This week. */
export function metGroups(input: PeopleInput, timeZone: string): Record<MetGroup, MetPerson[]> {
  const groups = groupNames(input.items.filter(live).map((i) => i.person ?? "").filter(Boolean), input.self ?? [], input.people ?? []);
  const all = groups.map((g) => metPerson(g, input, timeZone)).filter((p): p is MetPerson => !!p);
  const pick = (k: MetGroup) => all.filter((p) => p.group === k);
  return {
    since: pick("since").sort((a, b) => b.sinceOldest - a.sinceOldest || b.open.length - a.open.length || a.person.name.localeCompare(b.person.name)),
    quiet: pick("quiet").sort((a, b) => b.ageDays - a.ageDays || a.person.name.localeCompare(b.person.name)),
    week: pick("week").sort((a, b) => b.open.length - a.open.length || a.person.name.localeCompare(b.person.name)),
  };
}

const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);

/** The row's second line. */
export function metLine(p: MetPerson, short: (iso: string) => string): string {
  const head = `${p.open.length} open`;
  if (p.group === "since") return p.sinceOldest === 1 && p.lastMet ? `${head} · met once since, on ${short(p.lastMet)}` : `${head} · met ${times(p.sinceOldest)} since the oldest`;
  if (p.group === "quiet") return `${head} · last met ${p.lastMet ? short(p.lastMet) : "never"}`;
  return `${head} · from ${short(p.oldestAt)}`;
}

export const metLate = (p: MetPerson) => p.overdue || p.ageDays >= OLD_DAYS;

/** "10 meetings since", "5 since · 24d late", "Not met since". */
export function sinceLabel(n: number, lateDays: number | null): string {
  if (lateDays !== null) return `${n} since · ${lateDays}d late`;
  if (!n) return "Not met since";
  return `${n} ${n === 1 ? "meeting" : "meetings"} since`;
}

/** The lede on a person. */
export function metLede(p: MetPerson, short: (iso: string) => string): string {
  const name = p.person.name.split(/\s+/)[0];
  const kept = p.items.filter((i) => i.status === "done").length;
  const first = p.met[0]?.startedAt;
  const head = first ? `You've been in ${p.met.length} ${p.met.length === 1 ? "meeting" : "meetings"} with ${name} since ${short(first)}.` : "";
  const tail = p.sinceOldest ? ` The oldest has sat through ${p.sinceOldest} ${p.sinceOldest === 1 ? "meeting" : "meetings"} without being closed.` : " You haven't met since the oldest was said.";
  return `${head} You kept ${kept} ${kept === 1 ? "promise" : "promises"} and ${p.open.length} ${p.open.length === 1 ? "is" : "are"} open.${tail}`.trim();
}

/** A Slack-style update covering what's open, the oldest asked as "still needed?". No AI. */
export function updateTemplate(name: string, open: Item[]): string {
  const first = name.split(/\s+/)[0];
  const owe = open.filter((i) => i.kind === "owe");
  const wait = open.filter((i) => i.kind === "waiting");
  const lower = (s: string) => s.replace(/\.$/, "").replace(/^./, (c) => c.toLowerCase());
  const oldest = owe[0];
  const lines = [
    `Hi ${first}, a quick status on what I owe you:`,
    ...owe.filter((i) => i !== oldest).map((i) => `• ${lower(i.text)}: on it.`),
    ...(oldest ? [`• ${lower(oldest.text)}: not started. Still needed, or drop it?`] : []),
    ...(wait.length ? ["", "And from you:", ...wait.map((i) => `• ${lower(i.text)}`)] : []),
  ];
  return lines.join("\n");
}
