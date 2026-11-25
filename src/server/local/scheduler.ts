import { deliverDue } from "@/server/jobs/deliver";
import { pollAll, pollUser } from "@/server/jobs/poll";
import { processAllPending, processPending } from "@/server/jobs/process";
import { logJobError } from "@/server/jobs/types";
import { buildDeps, getStore } from "./app";

const TICK_MS = 5 * 60_000;
const POLL_EVERY_MS = 30 * 60_000;

/** Progress of the last "Pull meetings since" run, shown on Settings. Lives only in this process. */
export interface PullState {
  /** "pull": new meetings since a date. "rebuild": every meeting read again, oldest first. */
  mode: "pull" | "rebuild";
  /** The date the user picked, YYYY-MM-DD. */
  date: string;
  startedAt: string;
  running: boolean;
  /** Meetings Wispr Flow returned for the window (null until listed). */
  found: number | null;
  processed: number;
  failed: number;
  error: string | null;
}

const g = globalThis as unknown as {
  __dbScheduler?: { timer: NodeJS.Timeout; lastPoll: number; running: boolean };
  __dbJobChain?: Promise<unknown>;
  __dbPull?: PullState;
};

/**
 * Runs `fn` after every job queued before it has finished. Polling and processing all go through
 * here, so two runs never read the same meeting at once (which used to create duplicate items).
 */
export function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const prev = g.__dbJobChain ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  g.__dbJobChain = next.catch(() => undefined);
  return next;
}

/**
 * Runs inside the app process: checks Wispr Flow every 30 minutes and delivers the brief at your
 * brief time. If the Mac was asleep at brief time, it delivers on the first tick after waking
 * (within an hour). Started from src/instrumentation.ts.
 */
export function startScheduler(): void {
  if (g.__dbScheduler) return;
  const st = { timer: setInterval(() => void tick(), TICK_MS), lastPoll: 0, running: false };
  g.__dbScheduler = st;
  setTimeout(() => void tick(), 5_000);

  async function tick() {
    if (st.running) return;
    st.running = true;
    try {
      await runExclusive(async () => {
        const deps = buildDeps();
        if ((await deps.store.listUsers()).length === 0) return;
        if (Date.now() - st.lastPoll >= POLL_EVERY_MS) {
          st.lastPoll = Date.now();
          await pollAll(deps);
          await processAllPending(deps, { deadline: Date.now() + 10 * 60_000 });
        }
        await deliverDue(deps);
      });
    } catch (e) {
      console.error("[scheduler]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    } finally {
      st.running = false;
    }
  }
}

/** For the "Check now" button. */
export async function checkNow(): Promise<void> {
  await runExclusive(async () => {
    const deps = buildDeps();
    await pollAll(deps);
    await processAllPending(deps, { deadline: Date.now() + 10 * 60_000 });
    if (g.__dbScheduler) g.__dbScheduler.lastPoll = Date.now();
  });
}

export function pullState(): PullState | null {
  return g.__dbPull ?? null;
}

/**
 * "Pull meetings since": fetch every meeting from `sinceIso` on and read the ones not read yet.
 * Meetings already in the app are skipped (upsert is keyed on the Wispr Flow id), so re-running it
 * is safe. Starts in the background and returns at once; progress is in pullState().
 */
export function startPullSince(userId: string, date: string, sinceIso: string): boolean {
  if (g.__dbPull?.running) return false;
  const state: PullState = { mode: "pull", date, startedAt: new Date().toISOString(), running: true, found: null, processed: 0, failed: 0, error: null };
  g.__dbPull = state;
  void runExclusive(async () => {
    const deps = buildDeps();
    try {
      const r = await pollUser(deps, userId, { since: sinceIso });
      if (!r.ok) {
        state.error = "Couldn't reach Wispr Flow.";
        return;
      }
      if (r.skipped) {
        state.error = "Wispr Flow isn't connected. Reconnect it first.";
        return;
      }
      state.found = r.found;
      const p = await processPending(deps, userId);
      state.processed = p.processed;
      state.failed = p.failed;
      if (p.failed) state.error = `${p.failed} meeting${p.failed === 1 ? "" : "s"} couldn't be read. Try again later.`;
    } catch (e) {
      state.error = "Something went wrong while pulling meetings.";
      console.error("[pull]", e instanceof Error ? e.name : "Error");
      await logJobError(deps, userId, "pull", e, {}, { includeMessage: false });
    } finally {
      state.running = false;
    }
  });
  return true;
}

/**
 * Settings: read every meeting again, oldest first, so later meetings can close earlier promises.
 * Needed after older meetings were pulled in after newer ones. Runs in the background.
 */
export function startRebuild(userId: string): boolean {
  if (g.__dbPull?.running) return false;
  const state: PullState = { mode: "rebuild", date: "", startedAt: new Date().toISOString(), running: true, found: null, processed: 0, failed: 0, error: null };
  g.__dbPull = state;
  void runExclusive(async () => {
    const deps = buildDeps();
    try {
      state.found = await getStore().resetExtraction(userId);
      const p = await processPending(deps, userId);
      state.processed = p.processed;
      state.failed = p.failed;
      if (p.failed) state.error = `${p.failed} meeting${p.failed === 1 ? "" : "s"} couldn't be read. Try again later.`;
    } catch (e) {
      state.error = "Something went wrong while re-reading meetings.";
      console.error("[rebuild]", e instanceof Error ? e.name : "Error");
      await logJobError(deps, userId, "rebuild", e, {}, { includeMessage: false });
    } finally {
      state.running = false;
    }
  });
  return true;
}
