// "Started in Slack, 10:42 PM": the latest hand-off event per item.
import { localDate } from "../brief/time";
import { clock, shortDate } from "./format";
import { HANDOFF_TARGETS, TARGET_LABEL, type HandoffTarget } from "./types";

export const HANDOFF_EVENT = "handoff";

export interface HandoffEvent {
  itemId: string;
  target: HandoffTarget;
  /** "copy" or "open". */
  how: "copy" | "open";
  at: string;
}

function isTarget(t: unknown): t is HandoffTarget {
  return typeof t === "string" && (HANDOFF_TARGETS as string[]).includes(t);
}

/** Latest hand-off per item from raw store events. */
export function latestHandoffs(events: Array<Record<string, unknown>>, userId: string): Map<string, HandoffEvent> {
  const out = new Map<string, HandoffEvent>();
  for (const e of events) {
    if (e.type !== HANDOFF_EVENT || e.userId !== userId) continue;
    const p = e.payload as { itemId?: unknown; target?: unknown; how?: unknown } | undefined;
    const at = typeof e.at === "string" ? e.at : null;
    if (!p || typeof p.itemId !== "string" || !isTarget(p.target) || !at) continue;
    const prev = out.get(p.itemId);
    if (!prev || prev.at <= at) out.set(p.itemId, { itemId: p.itemId, target: p.target, how: p.how === "open" ? "open" : "copy", at });
  }
  return out;
}

/** "Started in Slack, 10:42 PM", with the date when it wasn't today. */
export function startedLabel(e: Pick<HandoffEvent, "target" | "at">, timeZone: string, now: Date): string {
  const when = localDate(new Date(e.at), timeZone) === localDate(now, timeZone)
    ? clock(e.at, timeZone)
    : `${shortDate(e.at, timeZone)}, ${clock(e.at, timeZone)}`;
  return `Started in ${TARGET_LABEL[e.target]}, ${when}`;
}
