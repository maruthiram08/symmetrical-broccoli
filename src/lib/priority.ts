// Priority: a local score for things you owe, so the most pressing come first. No API calls.
// The score adds up a few plain signals, each with a reason shown on hover and in the CLI:
//   overdue        60, plus 5 a day late (up to +40)
//   due soon       40 within 24 hours, 20 within 3 days
//   starred        35
//   person waiting 6 for each other open thing you owe the same person (up to +24)
//   age            1 a day since it was promised (up to +20)

import { lateLabel } from "@/lib/brief/time";
import { normalizeName } from "@/lib/people";
import type { Item } from "@/lib/types";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface Priority {
  score: number;
  /** Short reasons, biggest first: "2d late", "due in 5h", "starred", "Nitin waits on 3", "open 9d". */
  reasons: string[];
}

export interface PriorityContext {
  now: Date;
  /** Every item (any status): used to count what each person is waiting on from you. */
  items: Item[];
  /** When each item was promised (meeting start), by item id. Falls back to createdAt. */
  startedAt?: (i: Item) => string;
}

/** Open things you owe, per person (normalized name). */
function waitingCounts(items: Item[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const i of items) {
    if (i.kind !== "owe" || i.status !== "open" || !i.person) continue;
    const k = normalizeName(i.person);
    if (k) m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

function hoursLabel(ms: number): string {
  const h = Math.max(1, Math.round(ms / HOUR));
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

/** Score one item. Higher is more pressing. */
export function priorityOf(i: Item, ctx: PriorityContext, counts = waitingCounts(ctx.items)): Priority {
  const now = ctx.now.getTime();
  const parts: Array<[number, string]> = [];
  if (i.dueAt && i.status === "open") {
    const left = Date.parse(i.dueAt) - now;
    if (left < 0) {
      const daysLate = Math.floor(-left / DAY);
      parts.push([60 + Math.min(40, daysLate * 5), lateLabel(Math.floor(-left / 60_000))]);
    } else if (left <= DAY) parts.push([40, `due in ${hoursLabel(left)}`]);
    else if (left <= 3 * DAY) parts.push([20, `due in ${hoursLabel(left)}`]);
  }
  if (i.starred) parts.push([35, "starred"]);
  if (i.person) {
    const others = (counts.get(normalizeName(i.person)) ?? 0) - (i.kind === "owe" && i.status === "open" ? 1 : 0);
    if (others > 0) parts.push([Math.min(24, others * 6), `${i.person} waits on ${others + 1}`]);
  }
  const since = Date.parse(ctx.startedAt?.(i) ?? i.createdAt);
  const age = Number.isFinite(since) ? Math.floor((now - since) / DAY) : 0;
  if (age >= 1) parts.push([Math.min(20, age), `open ${age}d`]);
  parts.sort((a, b) => b[0] - a[0]);
  return { score: parts.reduce((s, [n]) => s + n, 0), reasons: parts.map(([, r]) => r) };
}

/**
 * Sort anything with an item id by priority, highest first. Ties keep the incoming order (stable),
 * so callers' own order (due time, then age) breaks them.
 */
export function rankByPriority<T>(xs: T[], idOf: (x: T) => string, ctx: PriorityContext): Array<T & { priority: Priority }> {
  const byId = new Map(ctx.items.map((i) => [i.id, i]));
  const counts = waitingCounts(ctx.items);
  return xs
    .map((x, k) => {
      const item = byId.get(idOf(x));
      return { x: { ...x, priority: item ? priorityOf(item, ctx, counts) : { score: 0, reasons: [] } }, k };
    })
    .sort((a, b) => b.x.priority.score - a.x.priority.score || a.k - b.k)
    .map(({ x }) => x);
}

/** The top `n` open things you owe from a ranked list (Today's "Top 3"). */
export function topN<T extends { priority: Priority }>(ranked: T[], n = 3): T[] {
  return ranked.filter((x) => x.priority.score > 0).slice(0, n);
}

/** The usual context: items plus their meetings, so age counts from when it was said. */
export function priorityContext(items: Item[], meetings: Array<{ id: string; startedAt: string }>, now: Date): PriorityContext {
  const at = new Map(meetings.map((m) => [m.id, m.startedAt]));
  return { now, items, startedAt: (i) => at.get(i.meetingId) ?? i.createdAt };
}
