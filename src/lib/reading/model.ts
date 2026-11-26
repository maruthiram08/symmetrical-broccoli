// The reading pane's lists: rows, groups and the Today overview, worked out from items and meetings.
// Pure: no store, no React. The pages (src/app/_lib/reading.ts) load the data and pass it in.
import { addDays, formatTime, lateLabel, localDate, localDayBounds } from "@/lib/brief/time";
import { isManual, isSnoozed } from "@/lib/capture/items";
import type { Item, ItemKind, ItemStatus, Meeting } from "@/lib/types";

/** Rows after this many in one group wait behind "Show N more". */
export const SHOW_LIMIT = 6;

export type RowMark = "owe" | "waiting" | "late" | "decision" | "done";

/** One list row: everything it shows, ready to serialize to the client. */
export interface Row {
  id: string;
  kind: ItemKind;
  status: ItemStatus;
  mark: RowMark;
  title: string;
  quote: string;
  /** "person · meeting · date" */
  meta: string;
  /** "24d", "24d late", "Back 3 Dec", "Kept 26 Nov" */
  badge: string;
  late: boolean;
  done: boolean;
}

export interface Group {
  key: string;
  label: string;
  /** The jump chip's label. */
  short: string;
  rows: Row[];
  /** Shown when the group has no rows. Groups without it are left out when empty. */
  empty?: string;
  late?: boolean;
}

export interface Ctx {
  meetings: Map<string, Meeting>;
  timeZone: string;
  now: Date;
}

const DAY = 86_400_000;
const isOpenWork = (i: Item) => i.status === "open" && i.kind !== "decision";

/** "25 Nov" in the zone. */
export function shortDay(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone });
}

/** "Thu 3 Dec" for a local "YYYY-MM-DD". */
export function dayName(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}

/** Whole local days from one local date to another. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / DAY);
}

/** When the item was heard: its meeting's start, else when it was added. */
export function heardAt(i: Item, meetings: Map<string, Meeting>): string {
  return meetings.get(i.meetingId)?.startedAt ?? i.createdAt;
}

/** Minutes past due for open work, else null. */
export function lateMinutes(i: Item, now: Date): number | null {
  if (!isOpenWork(i) || !i.dueAt) return null;
  const ms = now.getTime() - Date.parse(i.dueAt);
  return ms > 0 ? Math.floor(ms / 60000) : null;
}

/** Days open since it was heard. */
export function ageDays(i: Item, ctx: Ctx): number {
  return Math.max(0, daysBetween(localDate(new Date(heardAt(i, ctx.meetings)), ctx.timeZone), localDate(ctx.now, ctx.timeZone)));
}

export function markOf(i: Item, now: Date): RowMark {
  if (i.status === "done") return "done";
  if (i.kind === "decision") return "decision";
  return lateMinutes(i, now) !== null ? "late" : i.kind;
}

export function badgeOf(i: Item, ctx: Ctx, opts: { showBack?: boolean } = {}): string {
  if (i.status === "done") return i.closedAt ? `Kept ${shortDay(i.closedAt, ctx.timeZone)}` : "Kept";
  if (i.kind === "decision") return shortDay(heardAt(i, ctx.meetings), ctx.timeZone);
  const late = lateMinutes(i, ctx.now);
  if (late !== null) return lateLabel(late);
  const today = localDate(ctx.now, ctx.timeZone);
  if (opts.showBack && isSnoozed(i, today)) return `Back ${dayName(i.snoozedUntil!).replace(/^\w+ /, "")}`;
  const age = ageDays(i, ctx);
  return age ? `${age}d` : "Today";
}

export function toRow(i: Item, ctx: Ctx, opts: { showBack?: boolean } = {}): Row {
  const m = ctx.meetings.get(i.meetingId);
  const meta = [
    i.person ?? "",
    m ? m.title || "Meeting" : isManual(i) ? "Added by you" : "",
    shortDay(heardAt(i, ctx.meetings), ctx.timeZone),
  ].filter(Boolean).join(" · ");
  const late = lateMinutes(i, ctx.now) !== null;
  return {
    id: i.id, kind: i.kind, status: i.status, mark: markOf(i, ctx.now), title: i.text,
    quote: isManual(i) ? (i.note ?? "") : i.quote, meta, badge: badgeOf(i, ctx, opts), late, done: i.status === "done",
  };
}

const byHeard = (ctx: Ctx) => (a: Item, b: Item) => heardAt(a, ctx.meetings).localeCompare(heardAt(b, ctx.meetings));
const starFirst = (a: Item, b: Item) => Number(!!b.starred) - Number(!!a.starred);
const mostLate = (now: Date) => (a: Item, b: Item) => (lateMinutes(b, now) ?? -1) - (lateMinutes(a, now) ?? -1);

/** Groups with no rows and no empty text are left out. */
const keep = (gs: Group[]) => gs.filter((g) => g.rows.length || g.empty);

export interface TodaySets {
  late: Item[];
  /** Awake, not late, but on today's brief: from today, due by tomorrow, or starred. */
  now: Item[];
  tomorrow: Item[];
  kept: Item[];
}

/** The items behind Today's groups and its overview. */
export function todaySets(items: Item[], ctx: Ctx): TodaySets {
  const tz = ctx.timeZone;
  const today = localDate(ctx.now, tz);
  const tomorrow = addDays(today, 1);
  const work = items.filter(isOpenWork);
  const awake = work.filter((i) => !isSnoozed(i, today));
  const late = awake.filter((i) => lateMinutes(i, ctx.now) !== null).sort(mostLate(ctx.now));
  const endTomorrow = Date.parse(localDayBounds(tomorrow, tz).endIso);
  const fromToday = (i: Item) => localDate(new Date(heardAt(i, ctx.meetings)), tz) === today;
  const now = awake
    .filter((i) => lateMinutes(i, ctx.now) === null && (i.starred || fromToday(i) || (!!i.dueAt && Date.parse(i.dueAt) < endTomorrow)))
    .sort((a, b) => starFirst(a, b) || (a.dueAt ?? "~").localeCompare(b.dueAt ?? "~") || byHeard(ctx)(a, b));
  const back = work.filter((i) => i.snoozedUntil === tomorrow).sort(byHeard(ctx));
  const kept = items
    .filter((i) => i.status === "done" && i.kind !== "decision" && !!i.closedAt && localDate(new Date(i.closedAt), tz) === today)
    .sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? ""));
  return { late, now, tomorrow: back, kept };
}

/** Today: Late, then what's on today's brief, Back tomorrow, Kept today. */
export function todayGroups(items: Item[], ctx: Ctx): Group[] {
  const s = todaySets(items, ctx);
  return keep([
    { key: "late", label: "Late", short: "Late", late: true, rows: s.late.map((i) => toRow(i, ctx)), empty: "Nothing late." },
    { key: "today", label: "On today's brief", short: "Today", rows: s.now.map((i) => toRow(i, ctx)) },
    { key: "tomorrow", label: "Back tomorrow", short: "Tomorrow", rows: s.tomorrow.map((i) => toRow(i, ctx)), empty: "Nothing comes back tomorrow." },
    { key: "kept", label: "Kept today", short: "Kept", rows: s.kept.map((i) => toRow(i, ctx)), empty: "Nothing kept yet today." },
  ]);
}

export type OpenGrouping = "day" | "person" | "project";

/**
 * All open: what you owe and wait on. By default grouped by the day it comes back (open now first,
 * then each snooze date); or by person, or by project (`projectTitle` names a project slug).
 */
export function openGroups(items: Item[], ctx: Ctx, by: OpenGrouping = "day", projectTitle: (slug: string) => string = (s) => s): Group[] {
  const today = localDate(ctx.now, ctx.timeZone);
  const work = items.filter(isOpenWork).sort((a, b) => starFirst(a, b) || mostLate(ctx.now)(a, b) || byHeard(ctx)(a, b));
  const bucket = (keyOf: (i: Item) => string) => {
    const m = new Map<string, Item[]>();
    for (const i of work) { const k = keyOf(i); m.set(k, [...(m.get(k) ?? []), i]); }
    return m;
  };
  if (by === "person" || by === "project") {
    const none = by === "person" ? "No one named" : "No project";
    const m = bucket((i) => (by === "person" ? i.person?.trim() : i.project) || none);
    return [...m.entries()]
      .sort((a, b) => Number(a[0] === none) - Number(b[0] === none) || b[1].length - a[1].length || a[0].localeCompare(b[0]))
      .map(([k, xs]) => {
        const label = by === "project" && k !== none ? projectTitle(k) : k;
        return { key: `${by}-${slugKey(k)}`, label, short: label, rows: xs.map((i) => toRow(i, ctx, { showBack: true })) };
      });
  }
  const m = bucket((i) => (isSnoozed(i, today) ? i.snoozedUntil! : ""));
  const tomorrow = addDays(today, 1);
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([d, xs]) => {
    const label = !d ? "Open now" : d === tomorrow ? "Back tomorrow" : `Back ${dayName(d)}`;
    const short = !d ? "Now" : d === tomorrow ? "Tomorrow" : dayName(d);
    return { key: d ? `d${d}` : "now", label, short, late: false, rows: xs.map((i) => toRow(i, ctx)) };
  });
}

function slugKey(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "x";
}

/** A person's page: what you owe them, what they owe you, decisions with them, and what was kept. */
export function personGroups(name: string, d: { youOwe: Item[]; waitingOn: Item[]; decisions: Item[]; closed: Item[] }, ctx: Ctx): Group[] {
  const first = name.split(/\s+/)[0] || name;
  return keep([
    { key: "owe", label: `You owe ${first}`, short: "You owe", rows: d.youOwe.map((i) => toRow(i, ctx, { showBack: true })), empty: "Nothing owed." },
    { key: "waiting", label: `${first} owes you`, short: "Waiting", rows: d.waitingOn.map((i) => toRow(i, ctx, { showBack: true })) },
    { key: "decisions", label: "Decided together", short: "Decisions", rows: d.decisions.map((i) => toRow(i, ctx)) },
    { key: "kept", label: "Kept", short: "Kept", rows: d.closed.map((i) => toRow(i, ctx)) },
  ]);
}

// ---------- visible rows and moving through them ----------

/** The ids a viewer can see, in order: each group's first SHOW_LIMIT unless it is expanded. */
export function visibleIds(groups: Array<{ key: string; ids: string[] }>, expanded: ReadonlySet<string>, limit = SHOW_LIMIT): string[] {
  return groups.flatMap((g) => (expanded.has(g.key) || g.ids.length <= limit ? g.ids : g.ids.slice(0, limit)));
}

/** The group to open so that `id` shows, when it sits behind "Show more". */
export function groupHiding(groups: Array<{ key: string; ids: string[] }>, id: string | null, limit = SHOW_LIMIT): string | null {
  if (!id) return null;
  const g = groups.find((x) => x.ids.indexOf(id) >= limit);
  return g ? g.key : null;
}

/** One step up or down the list; null when there is nothing to move to. Starts at the top. */
export function step(ids: string[], current: string | null, delta: 1 | -1): string | null {
  if (!ids.length) return null;
  const at = current ? ids.indexOf(current) : -1;
  if (at < 0) return delta > 0 ? ids[0] : ids[ids.length - 1];
  const next = Math.max(0, Math.min(ids.length - 1, at + delta));
  return ids[next];
}

/** Where selection goes when `id` leaves the list (done, snoozed): the next row, else the one before. */
export function afterRemoving(ids: string[], id: string): string | null {
  const at = ids.indexOf(id);
  if (at < 0) return ids[0] ?? null;
  return ids[at + 1] ?? ids[at - 1] ?? null;
}

export type KeyCommand = "next" | "prev" | "done" | "snooze" | "block" | "start" | "project" | "star" | "copy" | "wrong" | "menu" | "close";

/** The reading pane's keys. `c` stays quick capture, so copying the quote is Shift+C. */
export function keyCommand(key: string, shift = false): KeyCommand | null {
  switch (key) {
    case "j": case "ArrowDown": return "next";
    case "k": case "ArrowUp": return "prev";
    case "e": case "E": case "d": return "done";
    case "s": case "z": return "snooze";
    case "b": return "block";
    case "t": case "F": return "start";
    case "p": return "project";
    case "f": return "star";
    case "C": return shift ? "copy" : null;
    case "w": return "wrong";
    case ".": return "menu";
    case "Escape": return "close";
    default: return null;
  }
}

/** The URL to land on after acting on `id`: the same page with the selection moved on. */
export function backUrl(pathname: string, search: string, param: string, selectId: string | null, undo?: { id: string; was: "done" | "wrong" }): string {
  const q = new URLSearchParams(search);
  q.delete("undo"); q.delete("was");
  if (selectId) q.set(param, selectId); else q.delete(param);
  if (undo) { q.set("undo", undo.id); q.set("was", undo.was); }
  const s = q.toString();
  return `${pathname}${s ? `?${s}` : ""}`;
}

// ---------- the Today overview ----------

export interface Reason { text: string; late: boolean }

export interface DoFirst { item: Item; reason: Reason }

/**
 * The top three to start with, each with why: late ones (most late first), then the oldest open,
 * then someone with several open with you, then a meeting that left several open.
 */
export function doFirst(items: Item[], ctx: Ctx, max = 3): DoFirst[] {
  const today = localDate(ctx.now, ctx.timeZone);
  const awake = items.filter((i) => isOpenWork(i) && !isSnoozed(i, today));
  const work = items.filter(isOpenWork);
  const out: DoFirst[] = [];
  const taken = new Set<string>();
  const add = (i: Item | undefined, reason: Reason) => {
    if (!i || taken.has(i.id) || out.length >= max) return;
    taken.add(i.id);
    out.push({ item: i, reason });
  };
  for (const i of awake.filter((x) => lateMinutes(x, ctx.now) !== null).sort(mostLate(ctx.now))) {
    const m = lateMinutes(i, ctx.now)!;
    const d = Math.floor(m / 1440);
    add(i, { text: d >= 1 ? `${d} day${d === 1 ? "" : "s"} late` : lateLabel(m), late: true });
  }
  const pool = (awake.length ? awake : work).filter((i) => !taken.has(i.id)).sort(byHeard(ctx));
  const oldest = pool[0];
  if (oldest) add(oldest, { text: `Oldest open · ${ageDays(oldest, ctx)} days`, late: false });
  const count = (key: (i: Item) => string | null) => {
    const m = new Map<string, Item[]>();
    for (const i of work) { const k = key(i); if (k) m.set(k, [...(m.get(k) ?? []), i]); }
    return [...m.entries()].filter(([, xs]) => xs.length >= 3).sort((a, b) => b[1].length - a[1].length);
  };
  for (const [name, xs] of count((i) => i.person?.trim() || null)) {
    add(pool.find((i) => xs.includes(i) && !taken.has(i.id)), { text: `${name} has ${xs.length} open with you`, late: false });
  }
  for (const [, xs] of count((i) => (isManual(i) ? null : i.meetingId))) {
    add(pool.find((i) => xs.includes(i) && !taken.has(i.id)), { text: `${xs.length} open from one meeting`, late: false });
  }
  for (const i of pool) add(i, { text: `${ageDays(i, ctx)} days open`, late: false });
  return out;
}

export interface MeetingCard {
  meeting: Meeting;
  time: string;
  rows: Array<Row & { note: string }>;
  /** Lines from it that were marked "not a promise". */
  notPromises: number;
}

/** Today's meetings, each with what came out of it and how it stands. */
export function todaysMeetings(items: Item[], meetings: Meeting[], ctx: Ctx): MeetingCard[] {
  const today = localDate(ctx.now, ctx.timeZone);
  return meetings
    .filter((m) => localDate(new Date(m.startedAt), ctx.timeZone) === today && (m.processedAt || items.some((i) => i.meetingId === m.id)))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .map((m) => {
      const mine = items.filter((i) => i.meetingId === m.id);
      return {
        meeting: m,
        time: formatTime(m.startedAt, ctx.timeZone),
        notPromises: mine.filter((i) => i.status === "wrong").length,
        rows: mine.filter((i) => i.status !== "wrong" && i.status !== "inbox").map((i) => {
          const r = toRow(i, ctx);
          const note = i.status === "done" ? `Kept${i.person ? ` · ${i.person}` : ""}` : i.kind === "decision" ? "Decision" : r.late ? r.badge : i.person ? `Open · ${i.person}` : "Open";
          return { ...r, note };
        }),
      };
    });
}

/** "Thursday, 26 November" */
export function longDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d, 12));
  const f = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { ...o, timeZone: "UTC" }).format(t);
  return `${f({ weekday: "long" })}, ${f({ day: "numeric" })} ${f({ month: "long" })}`;
}

const WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
const word = (n: number) => WORDS[n] ?? String(n);

/** One sentence for the day: "One meeting today and 17 promises kept. Two are still late." */
export function daySentence(c: { meetings: number; kept: number; late: number; tomorrow: number }): string {
  const met = c.meetings ? `${word(c.meetings)} meeting${c.meetings === 1 ? "" : "s"} today` : "No meetings today";
  const kept = c.kept ? ` and ${c.kept} promise${c.kept === 1 ? "" : "s"} kept` : "";
  const late = c.late ? ` ${word(c.late)} ${c.late === 1 ? "is" : "are"} still late.` : " Nothing is late.";
  const back = c.tomorrow ? ` ${c.tomorrow} come${c.tomorrow === 1 ? "s" : ""} back tomorrow.` : "";
  return `${met}${kept}.${late}${back}`;
}

/** "Morning", "Afternoon" or "Evening wrap", by the local hour. */
export function partOfDay(now: Date, timeZone: string): string {
  const h = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone }).format(now));
  return h < 12 ? "Morning brief" : h < 17 ? "Afternoon" : "Evening wrap";
}

/** Snoozed items coming back after tomorrow, counted per day, soonest first. */
export function comingBack(items: Item[], ctx: Ctx, max = 5): Array<{ date: string; label: string; count: number }> {
  const tomorrow = addDays(localDate(ctx.now, ctx.timeZone), 1);
  const m = new Map<string, number>();
  for (const i of items) if (isOpenWork(i) && i.snoozedUntil && i.snoozedUntil > tomorrow) m.set(i.snoozedUntil, (m.get(i.snoozedUntil) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(0, max).map(([date, count]) => ({ date, label: dayName(date), count }));
}

// ---------- projects ----------

export interface ProjectSummary {
  slug: string;
  title: string;
  owe: Item[];
  waiting: Item[];
  decisions: Item[];
  kept: number;
  /** Newest first. */
  meetings: Meeting[];
  people: string[];
  /** Latest activity (meeting or item), ISO, "" when none. */
  last: string;
}

/** Every project with its open items and the meetings that fed it, most active first. */
export function projectSummaries(projects: Array<{ slug: string; title: string }>, items: Item[], meetings: Meeting[]): ProjectSummary[] {
  const byId = new Map(meetings.map((m) => [m.id, m]));
  const ctxSort = (a: Item, b: Item) => heardAt(a, byId).localeCompare(heardAt(b, byId));
  return projects.map((p) => {
    const mine = items.filter((i) => i.project === p.slug && i.status !== "wrong" && i.status !== "inbox");
    const open = mine.filter((i) => i.status === "open");
    const fed = [...new Set(mine.map((i) => i.meetingId))].map((id) => byId.get(id)).filter((m): m is Meeting => !!m)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const people = [...new Set(mine.map((i) => i.person?.trim()).filter((x): x is string => !!x))];
    const last = [fed[0]?.startedAt ?? "", ...mine.map((i) => i.createdAt)].sort().pop() ?? "";
    return {
      slug: p.slug, title: p.title, last, meetings: fed, people,
      owe: open.filter((i) => i.kind === "owe").sort((a, b) => starFirst(a, b) || ctxSort(a, b)),
      waiting: open.filter((i) => i.kind === "waiting").sort((a, b) => starFirst(a, b) || ctxSort(a, b)),
      decisions: open.filter((i) => i.kind === "decision").sort((a, b) => ctxSort(b, a)),
      kept: mine.filter((i) => i.status === "done").length,
    };
  }).sort((a, b) => b.last.localeCompare(a.last) || a.title.localeCompare(b.title));
}

/** "4 open · 2 decisions · 15 kept" */
export function projectLine(p: ProjectSummary): string {
  const open = p.owe.length + p.waiting.length;
  const d = p.decisions.length;
  return `${open} open · ${d} decision${d === 1 ? "" : "s"} · ${p.kept} kept`;
}
