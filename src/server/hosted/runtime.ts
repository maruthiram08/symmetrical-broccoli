// Production wiring for the hosted jobs: cron routes and background work started by a page.
import { after } from "next/server";
import { env } from "@/lib/env";
import type { User } from "@/lib/types";
import { aiClient } from "@/server/ai";
import { pollUser } from "@/server/jobs/poll";
import { processPending } from "@/server/jobs/process";
import { logJobError } from "@/server/jobs/types";
import { runContradictions, runNudges } from "@/server/local/ai-jobs";
import { loadAiFor, persistAi } from "./ai-state";
import { hostedDeps, rootStore, sessionUserId } from "./app";
import { hostedConfig } from "./config";
import { withUserLock } from "./db";
import type { CronRuntime } from "./jobs";

/** Contradiction check (and, after the brief, nudges) for one user. Never throws. */
export async function hostedAi(user: User, opts: { nudges: boolean }): Promise<void> {
  const store = rootStore().forUser(user.id);
  try {
    const ai = await loadAiFor(store, user.id);
    const deps = { store, ai, client: aiClient(), model: env.extractionModel, now: () => new Date() };
    try { await runContradictions(deps, user); } catch (e) { await logJobError(deps, user.id, "contradictions", e); }
    if (opts.nudges) { try { await runNudges(deps, user); } catch (e) { await logJobError(deps, user.id, "nudges", e); } }
    await persistAi(store, user.id, ai);
  } catch (e) {
    console.error(`[ai] user=${user.id} ${e instanceof Error ? e.name : "Error"}`);
  }
}

export function cronRuntime(): CronRuntime {
  const root = rootStore();
  return { root, concurrency: hostedConfig().concurrency, depsFor: (id) => hostedDeps(id, root), ai: hostedAi };
}

/**
 * Work a page starts (first read, Check now, Retry, Re-read): runs after the response, under the
 * user's lock, on Vercel's waitUntil (up to the function's maxDuration). Skipped when a cron run
 * already holds the lock: that run does the same work.
 */
export async function hostedBackground(job: string, work: (userId: string) => Promise<unknown>): Promise<boolean> {
  const userId = await sessionUserId();
  if (!userId) return false;
  after(async () => {
    try {
      await withUserLock(rootStore().db, userId, () => work(userId));
    } catch (e) {
      await logJobError({ store: rootStore().forUser(userId) }, userId, job, e, {}, { includeMessage: false });
    }
  });
  return true;
}

export const hostedCheckNow = () => hostedBackground("check_now", async (userId) => {
  const deps = hostedDeps(userId);
  if ((await deps.store.getConnection(userId))?.lastSeenAt == null) return;
  await pollUser(deps, userId);
  await processPending(deps, userId, { deadline: Date.now() + 4 * 60_000 });
});

/**
 * "Read meetings since": moves the connection's lastSeenAt back to that date first, so even if
 * the background run is cut short the next cron poll reads from there.
 */
export async function hostedPullSince(sinceIso: string): Promise<boolean> {
  const userId = await sessionUserId();
  if (!userId) return false;
  const store = rootStore().forUser(userId);
  const conn = await store.getConnection(userId);
  if (conn && (conn.lastSeenAt === null || sinceIso < conn.lastSeenAt)) await store.saveConnection({ ...conn, lastSeenAt: sinceIso });
  return pullInBackground(sinceIso);
}

const pullInBackground = (sinceIso: string) => hostedBackground("pull", async (userId) => {
  const deps = hostedDeps(userId);
  const r = await pollUser(deps, userId, { since: sinceIso });
  if (r.ok && !r.skipped) await processPending(deps, userId, { deadline: Date.now() + 4 * 60_000 });
});

export const hostedRebuild = () => hostedBackground("rebuild", async (userId) => {
  const deps = hostedDeps(userId);
  await rootStore().forUser(userId).resetExtraction(userId);
  await processPending(deps, userId, { deadline: Date.now() + 4 * 60_000 });
});

export const hostedRetry = () => hostedBackground("retry", async (userId) => {
  await processPending(hostedDeps(userId), userId, { deadline: Date.now() + 4 * 60_000 });
});
