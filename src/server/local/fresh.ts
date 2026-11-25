import type { Item } from "@/lib/types";
import type { MemoryStore } from "@/server/store";
import { macNotify } from "./publish";

/** Meetings that started longer ago than this are backfill or a re-read: no notification. */
export const FRESH_WINDOW_MS = 3 * 60 * 60_000;

/** "2 you owe, 1 waiting, 1 decision", or null when the meeting produced nothing. */
export function freshSummary(items: Pick<Item, "kind">[]): string | null {
  const n = (k: Item["kind"]) => items.filter((i) => i.kind === k).length;
  const parts = [
    n("owe") ? `${n("owe")} you owe` : null,
    n("waiting") ? `${n("waiting")} waiting` : null,
    n("decision") ? `${n("decision")} ${n("decision") === 1 ? "decision" : "decisions"}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

/**
 * Right after a meeting: one quiet Mac notification per newly read meeting that produced items,
 * "From Design sync: 2 you owe, 1 waiting". Meetings that started more than 3 hours ago (backfill,
 * re-reads) are skipped. Once per meeting, remembered with the prep-notice keys. Never throws.
 */
export async function notifyFreshMeetings(
  store: MemoryStore,
  now: Date,
  notify: (title: string, body: string) => void = macNotify,
): Promise<number> {
  let sent = 0;
  try {
    const since = new Date(now.getTime() - FRESH_WINDOW_MS).toISOString();
    for (const user of await store.listUsers()) {
      const recent = (await store.listMeetingsBetween(user.id, since, "9999")).filter((m) => m.processedAt && m.processedAt >= since);
      if (!recent.length) continue;
      const items = (await store.listItems(user.id)).filter((i) => i.status !== "wrong");
      for (const m of recent.sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
        const body = freshSummary(items.filter((i) => i.meetingId === m.id));
        if (!body) continue;
        if (!(await store.markPrepNotified(`${user.id}:fresh:${m.id}`))) continue;
        notify("Meeting just read", `From ${m.title}: ${body}`);
        sent++;
      }
    }
  } catch (e) {
    console.error("[fresh]", e instanceof Error ? e.name : "Error");
  }
  return sent;
}
