// "Cross-check all meetings": every Wispr Flow meeting that has been read, one at a time, through
// the scheduler's job chain (runExclusive) like the other long jobs. Progress lives in this process.
import { providerOf } from "@/lib/types";
import { errLine } from "@/server/local/log";
import { buildDeps, getFileStore } from "@/server/local/app";
import { runExclusive } from "@/server/local/scheduler";
import { currentWorkspace } from "@/server/local/workspaces";
import { isHosted } from "@/server/mode";
import { ReconnectRequiredError } from "@/server/wispr/oauth";
import type { WisprClient } from "@/server/wispr/client";
import { crossCheckMeeting, type CrossDeps } from "./core";
import { extractionModel } from "./model";

export interface CrossAllState {
  workspaceId: string;
  startedAt: string;
  running: boolean;
  total: number;
  done: number;
  failed: number;
  error: string | null;
}

const g = globalThis as unknown as { __dbCrossAll?: CrossAllState };

export function crossAllState(): CrossAllState | null {
  const s = g.__dbCrossAll ?? null;
  return s && s.workspaceId === currentWorkspace().id ? s : null;
}

/**
 * Runs the batch over `meetingIds` with one Wispr Flow connection. Stops at a reconnect error or
 * when the model has no key; any other failure is stored on that meeting and the run goes on.
 */
export async function runCrossAll(deps: CrossDeps, userId: string, meetingIds: string[], state: Pick<CrossAllState, "done" | "failed" | "error">): Promise<void> {
  const pick = await deps.model();
  if ("error" in pick) { state.error = pick.error; return; }
  const model = async () => pick;
  let client: WisprClient | null = null;
  try {
    for (const id of meetingIds) {
      try {
        const r = await crossCheckMeeting({ ...deps, model }, id, { client: (client ??= deps.wispr(userId)) });
        if ("status" in r && r.status === "error") {
          state.failed++;
          if (r.failure === "auth" || r.failure === "credit") { state.error = r.error ?? null; break; }
        }
      } catch (e) {
        state.failed++;
        if (e instanceof ReconnectRequiredError) { state.error = "Wispr Flow needs to be reconnected."; break; }
        console.error(`[crosscheck] ${errLine(e, { message: false })}`);
      } finally {
        state.done++;
      }
    }
  } finally {
    await (client as WisprClient | null)?.close?.();
  }
}

/** Starts the batch in the background. False when one is already running (or in hosted mode). */
export async function startCrossAll(userId: string): Promise<boolean> {
  if (isHosted() || g.__dbCrossAll?.running) return false;
  const store = getFileStore();
  const meetings = (await store.listMeetingsBetween(userId, "0000-01-01T00:00:00.000Z", "9999-12-31T00:00:00.000Z"))
    .filter((m) => providerOf(m) === "wispr_flow" && !!m.processedAt)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const state: CrossAllState = { workspaceId: currentWorkspace().id, startedAt: new Date().toISOString(), running: true, total: meetings.length, done: 0, failed: 0, error: null };
  g.__dbCrossAll = state;
  void runExclusive(async () => {
    const d = buildDeps();
    try {
      await runCrossAll({ store: getFileStore(), wispr: d.wispr, model: extractionModel, now: d.now }, userId, meetings.map((m) => m.id), state);
    } catch (e) {
      state.error = "Something went wrong while cross-checking.";
      console.error(`[crosscheck] ${errLine(e, { message: false })}`);
    } finally {
      state.running = false;
    }
  });
  return true;
}
