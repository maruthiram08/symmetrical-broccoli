import { WISPR_TOOLS, type WisprClient } from "@/server/wispr/client";
import { ReconnectRequiredError } from "@/server/wispr/oauth";
import type { Store } from "@/server/store";
import { logJobError, mapLimit, type Deps } from "./types";

export const BACKFILL_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export function backfillStart(now: Date): string {
  return new Date(now.getTime() - BACKFILL_DAYS * DAY_MS).toISOString();
}

export type PollResult =
  | { userId: string; ok: true; skipped?: "not_connected" | "needs_reconnect"; found: number; created: number }
  | { userId: string; ok: false; error: string };

/**
 * Queue a user's new meetings. Fetches from lastSeenAt (or 7 days back on the first run), upserts
 * each finalized meeting (idempotent on providerMeetingId) and advances lastSeenAt.
 * Never throws: a failure is logged as a job_error event and returned.
 */
export async function pollUser(
  deps: Pick<Deps, "store" | "wispr" | "now">,
  userId: string,
  opts: { since?: string; client?: WisprClient } = {},
): Promise<PollResult> {
  const { store } = deps;
  try {
    const conn = await store.getConnection(userId);
    if (!conn) return { userId, ok: true, skipped: "not_connected", found: 0, created: 0 };
    if (conn.status === "needs_reconnect") return { userId, ok: true, skipped: "needs_reconnect", found: 0, created: 0 };

    const now = deps.now();
    const since = opts.since ?? conn.lastSeenAt ?? backfillStart(now);
    const client = opts.client ?? deps.wispr(userId);
    const includeShared = (await store.getUser(userId))?.includeShared === true;
    let meetings;
    try {
      meetings = await client.listMeetingsSince(since, { includeShared });
      await cacheUpcoming(store, userId, client, now);
    } finally {
      if (!opts.client) await client.close?.();
    }

    let created = 0;
    let newestQueued: string | null = null;
    let oldestBlocked: string | null = null;
    for (const m of meetings) {
      const stale = now.getTime() - Date.parse(m.startedAt) > WISPR_TOOLS.unfinalizedGiveUpMs;
      if (!m.finalized && !stale) {
        // Still recording: don't queue it, and don't let lastSeenAt move past it.
        if (!oldestBlocked || m.startedAt < oldestBlocked) oldestBlocked = m.startedAt;
        continue;
      }
      const r = await store.upsertMeeting({
        userId,
        providerMeetingId: m.providerMeetingId,
        title: m.title,
        startedAt: m.startedAt,
        participants: m.participants,
        ...(m.link ? { link: m.link } : {}),
        ...(m.shared ? { shared: true, ...(m.ownerName ? { ownerName: m.ownerName } : {}) } : {}),
      });
      if (r.created) created++;
      if (!newestQueued || m.startedAt > newestQueued) newestQueued = m.startedAt;
    }

    // `since` is inclusive, so pointing lastSeenAt at a blocked meeting re-fetches it next time.
    let lastSeenAt = conn.lastSeenAt;
    if (oldestBlocked) lastSeenAt = newestQueued && newestQueued < oldestBlocked ? newestQueued : oldestBlocked;
    else if (newestQueued && (!lastSeenAt || newestQueued > lastSeenAt)) lastSeenAt = newestQueued;
    else if (!lastSeenAt) lastSeenAt = since; // first run found nothing: mark the backfill as done

    if (lastSeenAt !== conn.lastSeenAt) {
      // Re-read: listing may have refreshed the tokens, which must not be overwritten.
      const latest = (await store.getConnection(userId)) ?? conn;
      await store.saveConnection({ ...latest, lastSeenAt });
    }
    return { userId, ok: true, found: meetings.length, created };
  } catch (e) {
    // ReconnectRequiredError is already logged by markNeedsReconnect.
    if (!(e instanceof ReconnectRequiredError)) await logJobError(deps, userId, "poll", e);
    return { userId, ok: false, error: e instanceof Error ? e.name : "Error" };
  }
}

/** How far ahead the prep card looks. */
export const UPCOMING_WINDOW_MIN = 60;

/**
 * Cache the meetings starting in the next hour, for the prep card and its notification.
 * Never throws: a failure (or a client without the tool) is logged to stderr and the old cache
 * is kept, so the rest of the poll goes on. Stale entries drop out by start time on their own.
 */
export async function cacheUpcoming(store: Store, userId: string, client: WisprClient, now: Date): Promise<void> {
  if (!client.listUpcoming || !store.saveUpcoming) return;
  try {
    const until = now.getTime() + UPCOMING_WINDOW_MIN * 60_000;
    const list = (await client.listUpcoming(UPCOMING_WINDOW_MIN / 60)).filter((m) => {
      const t = Date.parse(m.startsAt);
      return t > now.getTime() && t <= until;
    });
    await store.saveUpcoming(userId, { fetchedAt: now.toISOString(), meetings: list });
  } catch (e) {
    console.error(`[upcoming] user=${userId} ${e instanceof Error ? `${e.name}: ${e.message.slice(0, 200)}` : "Error"}`);
  }
}

/**
 * Poll every user. With `waitForFirstRead`, a user who connected but hasn't started their first
 * read (lastSeenAt still null) is left alone: the local app's /welcome asks how far back to read
 * and shows the cost first, so the background poll must not start a 7-day read behind their back.
 */
export async function pollAll(
  deps: Pick<Deps, "store" | "wispr" | "now">,
  opts: { concurrency?: number; waitForFirstRead?: boolean } = {},
): Promise<PollResult[]> {
  let users = await deps.store.listUsers();
  if (opts.waitForFirstRead) {
    const ready: typeof users = [];
    for (const u of users) if ((await deps.store.getConnection(u.id))?.lastSeenAt != null) ready.push(u);
    users = ready;
  }
  return mapLimit(users, opts.concurrency ?? 4, (u) => pollUser(deps, u.id));
}
