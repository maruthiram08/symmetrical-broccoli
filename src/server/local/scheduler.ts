import { join } from "node:path";
import { deliverDue, type DeliverResult } from "@/server/jobs/deliver";
import { pollAll, pollUser } from "@/server/jobs/poll";
import { processAllPending, processPending } from "@/server/jobs/process";
import { logJobError, type Deps } from "@/server/jobs/types";
import { buildDeps, getStore } from "./app";
import { SchedulerLock } from "./lock";
import { errLine, rotateLog } from "./log";
import { dataDir } from "./paths";
import { notifyPrep } from "./prep";
import { notifyFreshMeetings } from "./fresh";
import { afterJobs } from "@/server/ai";

export const TICK_MS = 5 * 60_000;
export const POLL_EVERY_MS = 30 * 60_000;
/** After a failed poll (say, the Mac just woke and Wi-Fi isn't back), try again this soon. */
export const POLL_RETRY_MS = 5 * 60_000;
/** A due brief waits this long for a working poll, so a just-woken Mac doesn't send a stale brief. */
export const DELIVER_WAIT_FOR_POLL_MS = 30 * 60_000;
const HEARTBEAT_MS = 60_000;

/** What the scheduler remembers between ticks. */
export interface TickState {
  lastPoll: number;
  /** Since when every poll has failed (epoch ms), or null. */
  pollFailingSince: number | null;
  lastTickAt: number;
}

export function newTickState(): TickState {
  return { lastPoll: 0, pollFailingSince: null, lastTickAt: 0 };
}

/**
 * One scheduler tick: poll and read meetings every 30 minutes, then deliver any brief that is due
 * today and not sent yet (catch-up: a brief missed while the Mac slept goes out once on waking).
 * A failed poll is retried after 5 minutes instead of 30, and delivery waits up to 30 minutes for
 * a poll that works, so a brief after waking includes the meetings from before the sleep.
 */
export async function runTick(
  deps: Deps,
  st: TickState,
  opts: { nowMs?: number; afterDeliver?: () => Promise<unknown>; afterProcess?: () => Promise<unknown> } = {},
): Promise<{ polled: boolean; delivered: DeliverResult[] }> {
  const nowMs = opts.nowMs ?? Date.now();
  if (st.lastTickAt && nowMs - st.lastTickAt > 3 * TICK_MS) {
    console.error(`[scheduler] resumed after ${Math.round((nowMs - st.lastTickAt) / 60_000)} min (sleep or offline); catching up`);
  }
  st.lastTickAt = nowMs;
  if ((await deps.store.listUsers()).length === 0) return { polled: false, delivered: [] };
  let polled = false;
  if (nowMs - st.lastPoll >= POLL_EVERY_MS) {
    polled = true;
    const results = await pollAll(deps, { waitForFirstRead: true });
    const failed = results.some((r) => !r.ok);
    st.lastPoll = failed ? nowMs - POLL_EVERY_MS + POLL_RETRY_MS : nowMs;
    st.pollFailingSince = failed ? st.pollFailingSince ?? nowMs : null;
    await processAllPending(deps, { deadline: nowMs + 10 * 60_000 });
    await opts.afterProcess?.();
  }
  const waitForPoll = st.pollFailingSince !== null && nowMs - st.pollFailingSince < DELIVER_WAIT_FOR_POLL_MS;
  const delivered = waitForPoll ? [] : await deliverDue(deps, deps.now(), { catchUp: true });
  await opts.afterDeliver?.();
  return { polled, delivered };
}

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
  __dbScheduler?: { timer: NodeJS.Timeout; beat: NodeJS.Timeout; tick: TickState; running: boolean; owner: boolean | null; lock: SchedulerLock };
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
 * brief time. If the Mac was asleep at brief time, it delivers once on waking (same day).
 * Only the process holding <data>/scheduler.lock runs jobs, so the launchd agent and the Mac app
 * can't both poll, read and notify. Started from src/instrumentation.ts.
 */
export function startScheduler(): void {
  if (g.__dbScheduler) return;
  const lock = new SchedulerLock(join(dataDir(), "scheduler.lock"));
  const st = {
    timer: setInterval(() => void tick(), TICK_MS),
    beat: setInterval(() => checkLock(), HEARTBEAT_MS),
    tick: newTickState(),
    running: false,
    owner: null as boolean | null, // null until the first check, so the first state is logged
    lock,
  };
  st.timer.unref?.();
  st.beat.unref?.();
  g.__dbScheduler = st;
  process.once("exit", () => lock.release());
  rotateLog();
  checkLock();
  setTimeout(() => void tick(), 5_000).unref?.();

  function checkLock(): boolean {
    const owner = lock.tryAcquire();
    if (owner !== st.owner) {
      const other = lock.holder();
      console.error(owner ? `[scheduler] running jobs in this process (pid ${process.pid})` : `[scheduler] another Daily brief (pid ${other?.pid ?? "?"}) runs the jobs; this one stays idle`);
      st.owner = owner;
    }
    return owner;
  }

  async function tick() {
    if (st.running || !checkLock()) return;
    st.running = true;
    try {
      rotateLog();
      await runExclusive(() => runTick(buildDeps(), st.tick, {
        afterDeliver: async () => {
          await notifyPrep(getStore(), new Date());
          await afterJobs(); // contradiction check on new decisions; nudges once a day after the brief
        },
        afterProcess: () => notifyFreshMeetings(getStore(), new Date()),
      }));
    } catch (e) {
      console.error(`[scheduler] ${errLine(e)}`);
    } finally {
      st.running = false;
    }
  }
}

/** Who runs the jobs, for the Health section. */
export function schedulerStatus(): { running: boolean; owner: boolean; holderPid: number | null } {
  const st = g.__dbScheduler;
  if (!st) return { running: false, owner: false, holderPid: null };
  return { running: true, owner: st.owner === true, holderPid: st.lock.holder()?.pid ?? null };
}

/** For the "Check now" button. */
export async function checkNow(): Promise<void> {
  await runExclusive(async () => {
    const deps = buildDeps();
    await pollAll(deps, { waitForFirstRead: true });
    await processAllPending(deps, { deadline: Date.now() + 10 * 60_000 });
    await notifyFreshMeetings(getStore(), deps.now());
    await afterJobs({ nudges: false });
    if (g.__dbScheduler) g.__dbScheduler.tick.lastPoll = Date.now();
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
      console.error(`[pull] ${errLine(e, { message: false })}`);
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
      console.error(`[rebuild] ${errLine(e, { message: false })}`);
      await logJobError(deps, userId, "rebuild", e, {}, { includeMessage: false });
    } finally {
      state.running = false;
    }
  });
  return true;
}

/**
 * Retry button: forget failed attempts and the Anthropic key/credit flag, then read the waiting
 * meetings in the background. Returns how many set-aside meetings were put back in the queue.
 */
export async function retryReading(userId: string): Promise<number> {
  const store = getStore();
  const n = await store.resetMeetingFailures(userId);
  await store.setHealth({ anthropicProblem: null });
  void runExclusive(async () => {
    const deps = buildDeps();
    try {
      await processPending(deps, userId, { deadline: Date.now() + 10 * 60_000 });
    } catch (e) {
      await logJobError(deps, userId, "retry", e, {}, { includeMessage: false });
    }
  });
  return n;
}
