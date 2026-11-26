import { localDate } from "@/lib/brief/time";
import { dueHints, type DueHint } from "@/lib/calendar/due";
import { tomorrowGlance } from "@/lib/calendar/glance";
import { CALENDAR_MAX_STALE_MS, freshEvents } from "@/lib/calendar/series";
import type { BriefModel, GlanceMeeting, User } from "@/lib/types";
import type { Store } from "@/server/store";

/** Tomorrow's meetings with open items; undefined when there are none or the calendar was never read (or is a day old). */
export async function tomorrowFor(store: Store, user: User, now: Date): Promise<GlanceMeeting[] | undefined> {
  const cache = (await store.getCalendar?.(user.id)) ?? null;
  if (!cache?.fetchedAt || now.getTime() - Date.parse(cache.fetchedAt) > CALENDAR_MAX_STALE_MS) return undefined;
  const glance = tomorrowGlance({
    events: freshEvents(cache, now), items: await store.listItems(user.id, { status: "open" }), series: cache.series,
    today: localDate(now, user.timeZone), timeZone: user.timeZone, now, self: [user.name, ...user.aliases],
    people: (await store.getPeople?.(user.id))?.people ?? [],
  });
  // No events tomorrow (or a calendar Wispr Flow can't see): show nothing rather than an empty heading.
  return glance.length ? glance : undefined;
}

/** The brief with tomorrow's meetings added (for the daily note). A failure leaves the brief as it was. */
export async function withTomorrow(store: Store, user: User, now: Date, model: BriefModel): Promise<BriefModel> {
  try {
    const tomorrow = await tomorrowFor(store, user, now);
    return tomorrow ? { ...model, tomorrow } : model;
  } catch (e) {
    console.error("[calendar] tomorrow", e instanceof Error ? e.name : "Error");
    return model;
  }
}

/** Due suggestions for every open item of the user. */
export async function dueHintsFor(store: Store, user: User, now: Date): Promise<Map<string, DueHint>> {
  const cache = (await store.getCalendar?.(user.id)) ?? null;
  const events = freshEvents(cache, now);
  if (!cache || !events.length || !cache.series.length) return new Map();
  return dueHints({
    items: await store.listItems(user.id, { status: "open" }),
    series: cache.series,
    meetings: await store.listMeetingsBetween(user.id, "0000", "9999"),
    events, now, self: [user.name, ...user.aliases],
    people: (await store.getPeople?.(user.id))?.people ?? [],
  });
}
