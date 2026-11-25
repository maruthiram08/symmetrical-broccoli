// Small text helpers shared by templates, prompts and the context pack.
import type { HandoffContext } from "./types";

/** "25 Nov" in the user's zone. */
export function shortDate(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "short" }).format(new Date(iso));
}

/** "10:42 PM" in the user's zone. */
export function clock(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(iso));
}

/** "Dividend banner, 25 Nov, 1:51 PM" or null. */
export function meetingLabel(ctx: Pick<HandoffContext, "meeting" | "user">): string | null {
  if (!ctx.meeting) return null;
  const { title, startedAt } = ctx.meeting;
  return `${title}, ${shortDate(startedAt, ctx.user.timeZone)}, ${clock(startedAt, ctx.user.timeZone)}`;
}

/** First name only: "Nitin Kumar" -> "Nitin". */
export function firstName(name: string | null): string | null {
  const n = name?.trim().split(/\s+/)[0];
  return n ? n : null;
}

/** Lower-cases the first letter unless it starts a name or acronym ("Send" -> "send", "API" stays). */
export function lowerFirst(s: string): string {
  if (/^[A-Z]{2}/.test(s)) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/** Cuts at a word boundary and adds an ellipsis. */
export function clip(s: string, max: number): string {
  const t = s.trim().replace(/\s+/g, " ");
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > max / 2 ? cut.slice(0, sp) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

export function dueWording(ctx: HandoffContext): string | null {
  const due = ctx.item.dueAt;
  if (!due) return null;
  const tz = ctx.user.timeZone;
  const when = `${shortDate(due, tz)}, ${clock(due, tz)}`;
  return Date.parse(due) < Date.parse(ctx.now) ? `was due ${when} (overdue)` : `due ${when}`;
}

export function wordCount(s: string): number {
  return (s.trim().match(/\S+/g) ?? []).length;
}
