import type { Store } from "@/server/store";
import { backfillStart, pollUser } from "./poll";
import { processPending } from "./process";
import { logJobError, type Deps } from "./types";

export interface BackfillSummary {
  meetings: number;
  /** Things the user said they would do ("owe" items) in those meetings. */
  promisesMade: number;
  /** Of those, how many are still open. */
  stillOpen: number;
  /** All meetings in the window have been processed. */
  done: boolean;
}

/** What the Connected page shows, computed from the store (so it can be polled while backfill runs). */
export async function backfillSummary(store: Store, userId: string, now: Date): Promise<BackfillSummary> {
  const meetings = await store.listMeetingsBetween(userId, backfillStart(now), now.toISOString());
  const ids = new Set(meetings.map((m) => m.id));
  const owed = (await store.listItems(userId)).filter((i) => i.kind === "owe" && ids.has(i.meetingId));
  return {
    meetings: meetings.length,
    promisesMade: owed.length,
    stillOpen: owed.filter((i) => i.status === "open").length,
    done: meetings.every((m) => m.processedAt !== null),
  };
}

/** First run after connecting: queue the last 7 days, process everything, report the totals. */
export async function backfillUser(deps: Deps, userId: string): Promise<BackfillSummary> {
  const now = deps.now();
  await pollUser(deps, userId, { since: backfillStart(now) });
  await processPending(deps, userId);
  const summary = await backfillSummary(deps.store, userId, deps.now());
  try {
    await deps.store.logEvent({ userId, type: "backfill", payload: summary });
  } catch (e) {
    await logJobError(deps, userId, "backfill", e);
  }
  return summary;
}
