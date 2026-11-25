import type { Item, ItemKind } from "@/lib/types";
import { meetingIndex, shortDay, type BriefData } from "./data";
import { esc } from "./markdown";
import { addDays, formatTime, localDate, localDayBounds } from "./time";

const DAY = 86_400_000;
export const STALE_DAYS = 7;
const TOP_PEOPLE = 5;

/** ISO week of a local date: Monday to Sunday, numbered by the week's Thursday. */
export function isoWeek(date: string): { year: number; week: number; key: string; monday: string; sunday: string } {
  const [y, mo, d] = date.split("-").map(Number);
  const t = Date.UTC(y, mo - 1, d);
  const dow = (new Date(t).getUTCDay() + 6) % 7; // Monday = 0
  const thursday = new Date(t + (3 - dow) * DAY);
  const year = thursday.getUTCFullYear();
  const week = 1 + Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / DAY / 7);
  const monday = addDays(date, -dow);
  return { year, week, key: `${year}-W${String(week).padStart(2, "0")}`, monday, sunday: addDays(monday, 6) };
}

/** The weekly recap is written with Friday's brief. */
export function isRecapDay(date: string): boolean {
  const [y, mo, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay() === 5;
}

/** "23–29 November", or "30 November – 6 December" across months. */
export function weekRangeLabel(monday: string, sunday: string): string {
  const fmt = (date: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { ...o, timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
  const sameMonth = monday.slice(0, 7) === sunday.slice(0, 7);
  return sameMonth
    ? `${Number(monday.slice(8))}–${fmt(sunday, { day: "numeric", month: "long" })}`
    : `${fmt(monday, { day: "numeric", month: "long" })} – ${fmt(sunday, { day: "numeric", month: "long" })}`;
}

export interface PersonCount { person: string; total: number; open: number }

export interface WeekDecision { itemId: string; text: string; quote: string; meetingTitle: string; day: string; time: string }

export interface StaleItem {
  itemId: string; kind: ItemKind; text: string; person: string | null; quote: string;
  meetingTitle: string; day: string; ageDays: number;
}

export interface WeekModel {
  key: string;          // "2026-W48"
  week: number;
  monday: string;
  sunday: string;
  label: string;        // "Week 48, 23–29 November"
  counts: { meetings: number; made: number; kept: number; late: number };
  youOwe: PersonCount[];
  oweYou: PersonCount[];
  decisions: WeekDecision[];
  stale: StaleItem[];
}

/** The week (Monday to Sunday, local) that contains `now`, up to `now`. Pure. */
export function buildWeek(data: BriefData, now: Date, timeZone: string): WeekModel {
  const w = isoWeek(localDate(now, timeZone));
  const startIso = localDayBounds(w.monday, timeZone).startIso;
  const endIso = localDayBounds(w.sunday, timeZone).endIso;
  const nowIso = now.toISOString();
  const inWeek = (iso: string | null | undefined) => !!iso && iso >= startIso && iso < endIso;
  const meeting = meetingIndex(data.meetings);
  const startOf = (i: Item) => meeting(i.meetingId)?.startedAt ?? i.createdAt;
  const fromWeek = (i: Item) => inWeek(meeting(i.meetingId)?.startedAt);
  const owe = data.items.filter((i) => i.kind === "owe");

  // Late: due this week (by now) and not closed by the due time.
  const late = owe.filter((i) => i.dueAt && inWeek(i.dueAt) && i.dueAt < nowIso && (i.status === "open" || (i.closedAt ?? "") > i.dueAt));

  const people = (kind: "owe" | "waiting"): PersonCount[] => {
    const by = new Map<string, PersonCount>();
    for (const i of data.items) {
      if (i.kind !== kind || !i.person?.trim() || !(fromWeek(i) || i.status === "open")) continue;
      const k = i.person.trim();
      const p = by.get(k) ?? { person: k, total: 0, open: 0 };
      p.total++;
      if (i.status === "open") p.open++;
      by.set(k, p);
    }
    return [...by.values()].sort((a, b) => b.open - a.open || b.total - a.total || a.person.localeCompare(b.person)).slice(0, TOP_PEOPLE);
  };

  const decisions = data.items
    .filter((i) => i.kind === "decision" && fromWeek(i))
    .sort((a, b) => startOf(a).localeCompare(startOf(b)))
    .map((i) => {
      const m = meeting(i.meetingId)!;
      return { itemId: i.id, text: i.text, quote: i.quote, meetingTitle: m.title, day: weekday(m.startedAt, timeZone), time: formatTime(m.startedAt, timeZone) };
    });

  const staleBefore = now.getTime() - STALE_DAYS * DAY;
  const stale = data.items
    .filter((i) => i.kind !== "decision" && i.status === "open" && Date.parse(startOf(i)) < staleBefore)
    .sort((a, b) => startOf(a).localeCompare(startOf(b)))
    .map((i) => {
      const m = meeting(i.meetingId);
      return {
        itemId: i.id, kind: i.kind, text: i.text, person: i.person, quote: i.quote,
        meetingTitle: m?.title ?? "a meeting", day: shortDay(startOf(i), timeZone),
        ageDays: Math.floor((now.getTime() - Date.parse(startOf(i))) / DAY),
      };
    });

  return {
    key: w.key, week: w.week, monday: w.monday, sunday: w.sunday,
    label: `Week ${w.week}, ${weekRangeLabel(w.monday, w.sunday)}`,
    counts: {
      meetings: data.meetings.filter((m) => m.processedAt && inWeek(m.startedAt)).length,
      made: owe.filter(fromWeek).length,
      kept: owe.filter((i) => i.status === "done" && inWeek(i.closedAt)).length,
      late: late.length,
    },
    youOwe: people("owe"),
    oweYou: people("waiting"),
    decisions,
    stale,
  };
}

/** "Mon 23 Nov" */
function weekday(iso: string, timeZone: string): string {
  const d = new Date(iso);
  const wd = d.toLocaleDateString("en-GB", { weekday: "short", timeZone });
  return `${wd} ${shortDay(iso, timeZone)}`;
}

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/** ~/Daily Brief/week-YYYY-Www.md */
export function renderWeekMarkdown(w: WeekModel): string {
  const out: string[] = [];
  out.push("---", `week: ${w.key}`, `from: ${w.monday}`, `to: ${w.sunday}`, `meetings: ${w.counts.meetings}`, `promises_made: ${w.counts.made}`, `kept: ${w.counts.kept}`, `late: ${w.counts.late}`, "---", "");
  out.push(`# ${w.label}`, "");
  out.push(`${plural(w.counts.made, "promise")} made, ${w.counts.kept} kept, ${w.counts.late} late. From ${plural(w.counts.meetings, "meeting")}.`, "");
  const people = (title: string, ps: PersonCount[]) => {
    if (!ps.length) return;
    out.push(`## ${title}`, "");
    for (const p of ps) out.push(`- ${esc(p.person)}: ${[p.open ? `${p.open} open` : "", p.total > p.open ? `${p.total - p.open} closed` : ""].filter(Boolean).join(", ")}`);
    out.push("");
  };
  people("People you owe", w.youOwe);
  people("People who owe you", w.oweYou);
  if (w.decisions.length) {
    out.push("## Decisions", "");
    for (const d of w.decisions) out.push(`- ${esc(d.text)}`, `  "${esc(d.quote)}" · ${esc(d.meetingTitle)}, ${d.day}, ${d.time}`);
    out.push("");
  }
  if (w.stale.length) {
    out.push(`## Open more than ${STALE_DAYS} days (${w.stale.length})`, "");
    for (const s of w.stale) out.push(`- [ ] ${esc(s.text)} (${s.ageDays}d)${s.kind === "waiting" ? " · waiting" : ""}`, `  "${esc(s.quote)}" · ${esc(s.meetingTitle)}, ${s.day}`);
    out.push("");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
