// Hosted jobs: the same poll / process / deliver jobs the Mac runs, for every user, from Vercel
// Cron. Each user runs under their own advisory lock (two overlapping cron runs, or a cron run
// and a "Check now", never work on one user at once), a few users at a time.
import { timingSafeEqual } from "node:crypto";
import type { User } from "@/lib/types";
import { isBriefDue, deliverUser, type DeliverResult } from "@/server/jobs/deliver";
import { pollUser } from "@/server/jobs/poll";
import { processPending } from "@/server/jobs/process";
import { logJobError, mapLimit, type Deps } from "@/server/jobs/types";
import { withUserLock } from "./db";
import type { HostedStore } from "./store";

export interface CronRuntime {
  root: HostedStore;
  concurrency: number;
  depsFor: (userId: string) => Deps;
  /** The AI extras for one user (contradictions; nudges after the brief). Optional; never throws. */
  ai?: (user: User, opts: { nudges: boolean }) => Promise<void>;
  /** Epoch ms clock for deadlines (tests). */
  clock?: () => number;
}

export type PollRun =
  | { userId: string; status: "locked" | "waiting_first_read" | "not_connected" }
  | { userId: string; status: "ok"; created: number; processed: number; failed: number; remaining: number }
  | { userId: string; status: "failed"; error: string };

/** Vercel Cron sends "Authorization: Bearer $CRON_SECRET". */
export function isCronAuthorized(req: Request, secret: string): boolean {
  if (!secret) return false;
  const given = Buffer.from(req.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Every 30 minutes: for each user, queue new meetings and read as many as fit before `deadline`
 * (and the free tier allows). A user whose first read hasn't started is left alone: /welcome asks
 * how far back to read first.
 */
export async function cronPoll(rt: CronRuntime, opts: { deadline: number }): Promise<PollRun[]> {
  const now = rt.clock ?? Date.now;
  const users = await rt.root.listUsers();
  return mapLimit(users, rt.concurrency, async (u): Promise<PollRun> => {
    if (now() > opts.deadline) return { userId: u.id, status: "locked" };
    try {
      const r = await withUserLock(rt.root.db, u.id, async (): Promise<PollRun> => {
        const deps = rt.depsFor(u.id);
        const conn = await deps.store.getConnection(u.id);
        if (!conn) return { userId: u.id, status: "not_connected" };
        if (conn.lastSeenAt === null) return { userId: u.id, status: "waiting_first_read" };
        const polled = await pollUser(deps, u.id);
        const p = await processPending(deps, u.id, { deadline: opts.deadline });
        await rt.ai?.(u, { nudges: false });
        if (!polled.ok) return { userId: u.id, status: "failed", error: polled.error };
        return { userId: u.id, status: "ok", created: polled.created, processed: p.processed, failed: p.failed, remaining: p.remaining };
      });
      return r.locked ? r.value : { userId: u.id, status: "locked" };
    } catch (e) {
      await logJobError({ store: rt.root.forUser(u.id) }, u.id, "cron_poll", e, {}, { includeMessage: false });
      return { userId: u.id, status: "failed", error: e instanceof Error ? e.name : "Error" };
    }
  });
}

export type DeliverRun = DeliverResult | { userId: string; status: "locked" };

/**
 * Every 15 minutes: send the brief to each user whose brief time has passed today and who has
 * none sent yet (so a failed or missed run is made up later the same day), then draft nudges.
 */
export async function cronDeliver(rt: CronRuntime, at: Date): Promise<DeliverRun[]> {
  const users = await rt.root.listUsers();
  return mapLimit(users, rt.concurrency, async (u): Promise<DeliverRun> => {
    if (!isBriefDue(u, at, undefined, { catchUp: true })) return { userId: u.id, status: "not_due" };
    try {
      const r = await withUserLock(rt.root.db, u.id, async () => {
        const deps = rt.depsFor(u.id);
        const res = await deliverUser(deps, u, at);
        if (res.status === "sent") await rt.ai?.(u, { nudges: true });
        return res;
      });
      return r.locked ? r.value : { userId: u.id, status: "locked" };
    } catch (e) {
      await logJobError({ store: rt.root.forUser(u.id) }, u.id, "cron_deliver", e, {}, { includeMessage: false });
      return { userId: u.id, status: "failed", error: e instanceof Error ? e.name : "Error" };
    }
  });
}

export function summarize<T extends { status: string }>(runs: T[]): Record<string, number> {
  const out: Record<string, number> = { users: runs.length };
  for (const r of runs) out[r.status] = (out[r.status] ?? 0) + 1;
  return out;
}
