import { formatTime } from "@/lib/brief/time";
import { nextUpcoming, prepFor, prepNotice, type Prep } from "@/lib/wow/prep";
import type { User } from "@/lib/types";
import type { MemoryStore } from "@/server/store";
import { macNotify } from "./publish";

/** Notify this many minutes (or fewer) before a meeting starts. Ticks are 5 minutes apart. */
export const PREP_NOTIFY_MIN = 10;

/** The prep card for Today: the next meeting in the coming hour and what's open with its people. */
export async function prepCard(store: MemoryStore, user: User, now: Date): Promise<Prep | null> {
  const cache = await store.getUpcoming(user.id);
  const next = cache ? nextUpcoming(cache.meetings, now) : null;
  if (!next) return null;
  return prepFor(next, await store.listItems(user.id, { status: "open" }), [user.name, ...user.aliases]);
}

/**
 * Show a Mac notification about ~10 minutes before each cached upcoming meeting, once per meeting
 * (keyed by calendar id and start, so a moved meeting is announced again). Never throws.
 */
export async function notifyPrep(
  store: MemoryStore,
  now: Date,
  notify: (title: string, body: string) => void = macNotify,
): Promise<number> {
  let sent = 0;
  try {
    for (const user of await store.listUsers()) {
      const cache = await store.getUpcoming(user.id);
      const next = cache ? nextUpcoming(cache.meetings, now, PREP_NOTIFY_MIN + 2) : null;
      if (!next) continue;
      if (!(await store.markPrepNotified(`${user.id}:${next.calendarId}:${next.startsAt}`))) continue;
      const p = prepFor(next, await store.listItems(user.id, { status: "open" }), [user.name, ...user.aliases]);
      notify(`Next: ${next.title} at ${formatTime(next.startsAt, user.timeZone)}`, prepNotice(p));
      sent++;
    }
  } catch (e) {
    console.error("[prep]", e instanceof Error ? `${e.name}: ${e.message.slice(0, 200)}` : e);
  }
  return sent;
}
