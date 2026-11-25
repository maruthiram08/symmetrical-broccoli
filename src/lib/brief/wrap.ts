import type { BriefModel, Item } from "@/lib/types";
import { meetingIndex, type BriefData } from "./data";
import { dateLabel, dueLabel, formatTime, lateLabel, localDate, localDayBounds } from "./time";

export interface WrapCounts {
  /** Meetings read today. */
  meetings: number;
  /** Promises (owe items) made in today's meetings. */
  made: number;
  /** Promises closed today, by a meeting or by you. */
  kept: number;
  /** Open promises past their due time. */
  late: number;
  /** All promises still open. */
  open: number;
}

export interface WrapPromise {
  itemId: string;
  text: string;
  person: string | null;
  quote: string;
  meetingTitle: string;
  meetingTime: string;
  state: "kept" | "late" | "open";
  /** "Kept", "3h late", "Tomorrow" or null. */
  label: string | null;
}

export interface WrapClose {
  itemId: string;
  text: string;
  /** The closing words, or null when you marked it done yourself. */
  closeQuote: string | null;
  person: string | null;
  closedInMeeting: string | null;
  /** Time of the closing meeting, or of your click. */
  closedAtTime: string;
}

export interface WrapModel {
  date: string;
  dateLabel: string;
  counts: WrapCounts;
  promises: WrapPromise[];
  closes: WrapClose[];
  /** Nothing made, nothing kept, nothing open: "Nothing owed. Go home." */
  empty: boolean;
}

const isLate = (i: Item, now: Date) => i.status === "open" && !!i.dueAt && Date.parse(i.dueAt) < now.getTime();

/** The evening wrap for the user's local today at `now`. Pure. Counts match buildBrief's `wrap`. */
export function buildWrap(data: BriefData, now: Date, timeZone: string): WrapModel {
  const date = localDate(now, timeZone);
  const { startIso, endIso } = localDayBounds(date, timeZone);
  const inToday = (iso: string | null | undefined) => !!iso && iso >= startIso && iso < endIso;
  const meeting = meetingIndex(data.meetings);
  const owe = data.items.filter((i) => i.kind === "owe");

  const madeToday = owe
    .filter((i) => inToday(meeting(i.meetingId)?.startedAt))
    .sort((a, b) => (meeting(a.meetingId)!.startedAt).localeCompare(meeting(b.meetingId)!.startedAt) || a.createdAt.localeCompare(b.createdAt));

  const counts: WrapCounts = {
    meetings: data.meetings.filter((m) => m.processedAt && inToday(m.startedAt)).length,
    made: madeToday.length,
    kept: owe.filter((i) => i.status === "done" && inToday(i.closedAt)).length,
    late: owe.filter((i) => isLate(i, now)).length,
    open: owe.filter((i) => i.status === "open").length,
  };

  const promises: WrapPromise[] = madeToday.map((i) => {
    const m = meeting(i.meetingId)!;
    const late = isLate(i, now);
    const state: WrapPromise["state"] = i.status === "done" ? "kept" : late ? "late" : "open";
    const label = state === "kept" ? "Kept"
      : state === "late" ? lateLabel(Math.floor((now.getTime() - Date.parse(i.dueAt!)) / 60000))
      : i.dueAt ? dueLabel(i.dueAt, now, timeZone) : null;
    return { itemId: i.id, text: i.text, person: i.person, quote: i.quote, meetingTitle: m.title, meetingTime: formatTime(m.startedAt, timeZone), state, label };
  });

  const closes: WrapClose[] = data.items
    .filter((i) => i.kind !== "decision" && i.status === "done" && inToday(i.closedAt))
    .sort((a, b) => a.closedAt!.localeCompare(b.closedAt!))
    .map((i) => {
      const m = i.closeQuote ? meeting(i.closedByMeetingId) : null;
      return {
        itemId: i.id, text: i.text, closeQuote: i.closeQuote, person: i.kind === "waiting" ? i.person : null,
        closedInMeeting: i.closeQuote ? m?.title ?? "a meeting" : null,
        closedAtTime: formatTime(m?.startedAt ?? i.closedAt!, timeZone),
      };
    });

  return {
    date, dateLabel: dateLabel(date), counts, promises, closes,
    empty: counts.made === 0 && counts.kept === 0 && counts.open === 0 && closes.length === 0,
  };
}

/** The "## Wrap" section of the daily note, from the brief's numbers. */
export function renderWrapSection(wrap: BriefModel["wrap"], open?: number): string[] {
  const out = ["## Wrap", ""];
  out.push(`- Meetings: ${wrap.meetings}`, `- Promises made: ${wrap.made}`, `- Kept: ${wrap.kept}`, `- Late: ${wrap.late}`);
  if (open !== undefined) out.push(`- Still open: ${open}`);
  out.push("");
  return out;
}
