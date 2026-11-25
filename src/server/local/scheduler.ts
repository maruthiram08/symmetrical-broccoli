import { deliverDue } from "@/server/jobs/deliver";
import { pollAll } from "@/server/jobs/poll";
import { processAllPending } from "@/server/jobs/process";
import { buildDeps } from "./app";

const TICK_MS = 5 * 60_000;
const POLL_EVERY_MS = 30 * 60_000;

const g = globalThis as unknown as { __dbScheduler?: { timer: NodeJS.Timeout; lastPoll: number; running: boolean } };

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
      const deps = buildDeps();
      if ((await deps.store.listUsers()).length === 0) return;
      if (Date.now() - st.lastPoll >= POLL_EVERY_MS) {
        st.lastPoll = Date.now();
        await pollAll(deps);
        await processAllPending(deps, { deadline: Date.now() + 10 * 60_000 });
      }
      await deliverDue(deps);
    } catch (e) {
      console.error("[scheduler]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    } finally {
      st.running = false;
    }
  }
}

/** For the "Check now" button. */
export async function checkNow(): Promise<void> {
  const deps = buildDeps();
  await pollAll(deps);
  await processAllPending(deps, { deadline: Date.now() + 10 * 60_000 });
  if (g.__dbScheduler) g.__dbScheduler.lastPoll = Date.now();
}
