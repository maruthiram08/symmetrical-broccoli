// Pure helpers for the library pages in the reading pane: Daily briefs, Recurring, Review, Notes,
// Tags and Settings. Everything here takes what the page already loaded; nothing reads a store.
import { addDays, localDate } from "@/lib/brief/time";
import type { Item, Meeting } from "@/lib/types";
import { badgeOf, dayName, heardAt, markOf, shortDay, todaySets, type Ctx } from "./model";

export function mondayOf(date: string): string {
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
  return addDays(date, -((dow + 6) % 7));
}

export interface DayGroup { key: "week" | "last" | "earlier"; label: string; dates: string[] }

/** Past days, newest first, as This week / Last week / Earlier. Empty groups are left out. */
export function weekGroups(dates: string[], today: string): DayGroup[] {
  const mon = mondayOf(today);
  const lastMon = addDays(mon, -7);
  const sorted = [...new Set(dates)].sort().reverse();
  const groups: DayGroup[] = [
    { key: "week", label: "This week", dates: sorted.filter((d) => d >= mon) },
    { key: "last", label: "Last week", dates: sorted.filter((d) => d >= lastMon && d < mon) },
    { key: "earlier", label: "Earlier", dates: sorted.filter((d) => d < lastMon) },
  ];
  return groups.filter((g) => g.dates.length);
}

/** "Today", "Wed" within a fortnight, "13 Nov" before. */
export function dayBadge(date: string, today: string): string {
  if (date === today) return "Today";
  const short = dayName(date); // "Wed 25 Nov"
  return date >= addDays(mondayOf(today), -7) ? short.split(" ")[0] : short.split(" ").slice(1).join(" ");
}

export function meetingsOn(date: string, meetings: Meeting[], timeZone: string): Meeting[] {
  return meetings
    .filter((m) => !m.duplicateOf && localDate(new Date(m.startedAt), timeZone) === date)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export interface DayParts { meetings: Meeting[]; owe: Item[]; decisions: Item[]; late: Item[] }

/** One day's brief: its meetings, what you were told you owe from them, what was decided, and (today) what's late. */
export function dayParts(date: string, items: Item[], meetings: Meeting[], ctx: Ctx): DayParts {
  const ms = meetingsOn(date, meetings, ctx.timeZone);
  const ids = new Set(ms.map((m) => m.id));
  const from = items.filter((i) => ids.has(i.meetingId) && i.status !== "wrong");
  const today = localDate(ctx.now, ctx.timeZone);
  const late = date === today ? todaySets(items, ctx).late : [];
  const lateIds = new Set(late.map((i) => i.id));
  return {
    meetings: ms,
    owe: from.filter((i) => i.kind !== "decision" && !lateIds.has(i.id)),
    decisions: from.filter((i) => i.kind === "decision"),
    late,
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The list row's second line: "1 meeting · 4 new · 5 decisions · 6 late", or the first meeting's name. */
export function dayLine(p: DayParts, isToday: boolean): string {
  if (!p.meetings.length) return isToday && p.late.length ? `No meetings · ${p.late.length} late` : "No meetings";
  if (isToday) {
    return [plural(p.meetings.length, "meeting"), `${p.owe.length} new`, plural(p.decisions.length, "decision"), p.late.length ? `${p.late.length} late` : ""].filter(Boolean).join(" · ");
  }
  const first = p.meetings[p.meetings.length - 1].title || "Meeting";
  return `${plural(p.meetings.length, "meeting")} · ${first}${p.meetings.length > 1 ? ` +${p.meetings.length - 1}` : ""}`;
}

/** The compact brief's lede: "1 meeting. 4 new, 5 decided, 6 late." */
export function dayLede(p: DayParts): string {
  const head = p.meetings.length ? `${plural(p.meetings.length, "meeting")}.` : "No meetings.";
  const parts = [`${p.owe.length} new`, `${p.decisions.length} decided`, p.late.length ? `${p.late.length} late` : ""].filter(Boolean);
  return `${head} ${parts.join(", ")}.`;
}

export interface ItemLine { key: string; href: string; mark: string; title: string; small: string; badge: string; late: boolean; done: boolean }

/** An item as a compact row: mark, text, "meeting · person" under it, and its badge. */
export function itemLine(i: Item, ctx: Ctx, href: string, opts: { small?: "meeting" | "quote" | "none"; badge?: string } = {}): ItemLine {
  const m = ctx.meetings.get(i.meetingId);
  const mark = markOf(i, ctx.now);
  const small = opts.small === "none" ? ""
    : opts.small === "quote" ? (i.quote ? `“${i.quote}”` : m?.title ?? "")
      : [m?.title || (i.origin ? (i.origin.app === "slack" ? "From Slack" : "From clipboard") : i.source === "manual" ? "Added by you" : ""), i.person ?? ""].filter(Boolean).join(" · ");
  return { key: i.id, href, mark, title: i.text, small, badge: opts.badge ?? badgeOf(i, ctx, { showBack: true }), late: mark === "late", done: i.status === "done" };
}

export interface MonthStats {
  meetings: number; made: number; kept: number; open: number; wrong: number; decisions: number;
  /** Kept out of made, as a whole percent; null with nothing made. */
  rate: number | null;
}

/** A period's numbers from the items made in it (by when they were heard). */
export function periodStats(items: Item[], meetings: Meeting[], ctx: Ctx, from: string, to: string): MonthStats {
  const inRange = (iso: string) => { const d = localDate(new Date(iso), ctx.timeZone); return d >= from && d <= to; };
  const ms = meetings.filter((m) => !m.duplicateOf && inRange(m.startedAt));
  const its = items.filter((i) => inRange(heardAt(i, ctx.meetings)));
  const promises = its.filter((i) => i.kind !== "decision");
  const kept = promises.filter((i) => i.status === "done").length;
  const wrong = promises.filter((i) => i.status === "wrong").length;
  const open = promises.filter((i) => i.status === "open").length;
  const made = promises.length;
  return { meetings: ms.length, made, kept, open, wrong, decisions: its.filter((i) => i.kind === "decision" && i.status !== "wrong").length, rate: made ? Math.round((kept / made) * 100) : null };
}

/** Count by a key, most first, ties by name. */
export function countBy<T>(xs: T[], key: (x: T) => string | null | undefined): Array<[string, number]> {
  const m = new Map<string, number>();
  for (const x of xs) { const k = key(x); if (k) m.set(k, (m.get(k) ?? 0) + 1); }
  return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** "2026-11" → "November 2026". */
export function monthName(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, 15)));
}

/** The first and last day of a month, "YYYY-MM-DD". */
export function monthBounds(ym: string): { from: string; to: string } {
  const [y, m] = ym.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, "0")}` };
}

export function prevMonth(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

/** Notes grouped the way the Notes list shows them. */
export type NoteGroupKey = "projects" | "people" | "meetings" | "daily" | "other";
export interface NoteEntry { path: string; title: string; type: string | null; updatedAt: string | null }

export function noteGroupOf(n: NoteEntry): NoteGroupKey {
  const t = (n.type ?? "").toLowerCase();
  const file = n.path.split("/").pop() ?? n.path;
  if (/^\d{4}-\d{2}-\d{2}\.md$/i.test(file) || t === "daily" || t === "decisions") return "daily";
  if (t === "project") return "projects";
  if (t === "person" || /^people\//i.test(n.path)) return "people";
  if (t === "meeting" || /^meetings\//i.test(n.path)) return "meetings";
  return "other";
}

export const NOTE_GROUPS: Array<{ key: NoteGroupKey; label: string; short: string }> = [
  { key: "projects", label: "Projects", short: "Projects" },
  { key: "people", label: "People", short: "People" },
  { key: "meetings", label: "Meetings", short: "Meetings" },
  { key: "daily", label: "Daily and decisions", short: "Daily" },
  { key: "other", label: "Other notes", short: "Other" },
];

export function groupNotes(notes: NoteEntry[]): Array<{ key: NoteGroupKey; label: string; short: string; notes: NoteEntry[] }> {
  return NOTE_GROUPS.map((g) => ({
    ...g,
    notes: notes.filter((n) => noteGroupOf(n) === g.key).sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.title.localeCompare(b.title)),
  })).filter((g) => g.notes.length);
}

/** "edited today" / "edited 25 Nov" for a note's row. */
export function editedLabel(iso: string | null, ctx: Pick<Ctx, "now" | "timeZone">): string {
  if (!iso) return "";
  return localDate(new Date(iso), ctx.timeZone) === localDate(ctx.now, ctx.timeZone) ? "edited today" : `edited ${shortDay(iso, ctx.timeZone)}`;
}

/** Settings sections, in list order, and which one a redirect's flash or #anchor belongs to. */
export const SETTINGS_SECTIONS = [
  { key: "you", label: "You" },
  { key: "meetings", label: "Meetings" },
  { key: "ai", label: "AI" },
  { key: "delivery", label: "Delivery" },
  { key: "tools", label: "Send to tools" },
  { key: "sync", label: "Notes and sync" },
  { key: "access", label: "Phone and other apps" },
  { key: "appearance", label: "Appearance" },
  { key: "health", label: "Health" },
] as const;
export type SettingsKey = (typeof SETTINGS_SECTIONS)[number]["key"];

/** The section to open: ?section= if valid, else the one a flash parameter came back for. */
export function settingsSection(q: Record<string, string | undefined>): SettingsKey {
  const want = q.section;
  if (want && SETTINGS_SECTIONS.some((s) => s.key === want)) return want as SettingsKey;
  if (q.error) return "you";
  if (q.pull || q.shared || q.upload || q.source || q.which) return "meetings";
  if (q.ai || q.p || q.remote) return "ai";
  if (q.ch || q.saved || q.test || q.err || q.removed) return "delivery";
  if (q.integ) return "tools";
  if (q.sync || q.git) return "sync";
  if (q.model) return "access";
  return "you";
}

/** Open, kept and decided across a set of meetings. */
export function seriesCounts(meetings: Meeting[], items: Item[]): { open: number; kept: number; decisions: number } {
  const ids = new Set(meetings.map((m) => m.id));
  const its = items.filter((i) => ids.has(i.meetingId));
  return {
    open: its.filter((i) => i.status === "open" && i.kind !== "decision").length,
    kept: its.filter((i) => i.status === "done").length,
    decisions: its.filter((i) => i.kind === "decision" && i.status !== "wrong").length,
  };
}

/** "Most weekdays", "About weekly", "Every other week" or "Now and then", from how often it happened. */
export function cadenceOf(meetings: Meeting[], timeZone: string): string {
  const days = [...new Set(meetings.map((m) => localDate(new Date(m.startedAt), timeZone)))].sort();
  if (days.length < 2) return "Once so far";
  const span = Math.max(1, (Date.parse(`${days[days.length - 1]}T12:00:00Z`) - Date.parse(`${days[0]}T12:00:00Z`)) / 86400000);
  const perWeek = (days.length / span) * 7;
  if (perWeek >= 2.5) return "Most weekdays";
  if (perWeek >= 0.8) return "About weekly";
  if (perWeek >= 0.4) return "Every other week";
  return "Now and then";
}
