import { notifyDue } from "@/lib/routines/schedule";
import { cadenceLabel } from "@/lib/routines/words";
import type { User } from "@/lib/types";
import { routineStore } from "@/server/routines";
import { errLine } from "./log";
import { osNotify } from "./publish";

/**
 * A Mac notification for each timed routine at its time, on the days it's due: once per occurrence,
 * and not when that occurrence is already done, skipped or snoozed. Runs every scheduler tick
 * (5 minutes apart), so it goes out within a tick of the time; a Mac that slept through it still
 * gets it on waking, for up to two hours. Never throws.
 */
export async function notifyRoutines(
  store: { listUsers(): Promise<User[]> },
  now: Date,
  notify: (title: string, body: string) => void = osNotify,
): Promise<number> {
  const rs = routineStore(store);
  if (!rs) return 0;
  let sent = 0;
  try {
    for (const user of await store.listUsers()) {
      const occ = await rs.listOccurrences(user.id);
      for (const r of await rs.listRoutines(user.id)) {
        const date = notifyDue(r, occ, now, user.timeZone);
        if (!date || !(await rs.markRoutineNotified(user.id, `${r.id}:${date}`))) continue;
        notify(r.title, `${cadenceLabel(r.cadence, r.time)}${r.person ? ` · for ${r.person}` : ""}`);
        sent++;
      }
    }
  } catch (e) {
    console.error(`[routines] ${errLine(e)}`);
  }
  return sent;
}
