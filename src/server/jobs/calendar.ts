import { addDays, localDate, localDayBounds } from "@/lib/brief/time";
import { mergeSeries } from "@/lib/calendar/series";
import type { CalendarCache, User } from "@/lib/types";
import type { Store } from "@/server/store";
import type { WisprClient } from "@/server/wispr/client";

/** Calendar data is read at most this often, whatever triggers the poll. */
export const CALENDAR_REFRESH_MS = 30 * 60_000;
/** Events cached from the start of today for this many days. */
export const CALENDAR_DAYS = 8;
/** list_meeting_series calls per refresh; the rest wait for the next one. */
export const SERIES_CHECKS_PER_REFRESH = 8;

const why = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message.slice(0, 200)}` : "Error");

/**
 * Refresh the calendar cache: events from the start of today for 8 days, and which recorded
 * meetings belong to a recurring series. Runs at most every 30 minutes (the cache says when next),
 * whether the last try worked or not. Never throws: failures go to stderr and the old data stays.
 * Returns true when it tried.
 */
export async function cacheCalendar(
  store: Store,
  user: Pick<User, "id" | "timeZone">,
  client: WisprClient,
  now: Date,
  /** Wispr Flow meeting ids to check for a series, newest first. */
  providerMeetingIds: string[] = [],
): Promise<boolean> {
  if (!store.saveCalendar || !store.getCalendar || (!client.searchCalendar && !client.listSeries)) return false;
  try {
    const old = await store.getCalendar(user.id);
    if (old && now.getTime() < Date.parse(old.nextFetchAt)) return false;

    const today = localDate(now, user.timeZone);
    const fromIso = localDayBounds(today, user.timeZone).startIso;
    const toIso = localDayBounds(addDays(today, CALENDAR_DAYS - 1), user.timeZone).endIso;
    const cache: CalendarCache = {
      fetchedAt: old?.fetchedAt ?? null,
      nextFetchAt: new Date(now.getTime() + CALENDAR_REFRESH_MS).toISOString(),
      fromIso: old?.fromIso ?? fromIso,
      toIso: old?.toIso ?? toIso,
      events: old?.events ?? [],
      series: old?.series ?? [],
      seriesChecked: { ...(old?.seriesChecked ?? {}) },
    };
    // Save the next-fetch time first, so a crash mid-way still waits 30 minutes.
    await store.saveCalendar(user.id, cache);

    if (client.searchCalendar) {
      try {
        cache.events = await client.searchCalendar(fromIso, toIso);
        cache.fetchedAt = now.toISOString();
        cache.fromIso = fromIso;
        cache.toIso = toIso;
      } catch (e) {
        console.error(`[calendar] events user=${user.id} ${why(e)}`);
      }
    }

    if (client.listSeries) {
      let calls = 0;
      for (const id of [...new Set(providerMeetingIds)]) {
        if (calls >= SERIES_CHECKS_PER_REFRESH) break;
        if (id in cache.seriesChecked) continue;
        calls++;
        try {
          const found = await client.listSeries(id);
          if (!found) {
            cache.seriesChecked[id] = null;
            continue;
          }
          const r = mergeSeries(cache.series, found);
          cache.series = r.series;
          for (const s of r.series) if (s.id === r.id) for (const p of s.providerMeetingIds) cache.seriesChecked[p] = r.id;
          // ids of series merged away now point at the survivor
          const live = new Set(r.series.map((s) => s.id));
          for (const [k, v] of Object.entries(cache.seriesChecked)) if (v && !live.has(v)) cache.seriesChecked[k] = r.id;
        } catch (e) {
          // A tool error (e.g. an unknown meeting id) won't fix itself; anything else is retried next time.
          if (e instanceof Error && /returned an error/.test(e.message)) cache.seriesChecked[id] = null;
          console.error(`[calendar] series user=${user.id} ${why(e)}`);
          if (!(e instanceof Error && /returned an error/.test(e.message))) break;
        }
      }
    }

    await store.saveCalendar(user.id, cache);
    return true;
  } catch (e) {
    console.error(`[calendar] user=${user.id} ${why(e)}`);
    return false;
  }
}
