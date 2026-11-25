import type { User } from "@/lib/types";
import { processPending } from "./process";
import { logJobError, mapLimit, type Deps } from "./types";

/** Wide enough to survive a missed cron tick; the once-per-day check stops a second send. */
export const DELIVER_WINDOW_MINUTES = 60;

/** Local calendar date "YYYY-MM-DD" and minutes since local midnight, for an IANA zone. */
export function localClock(now: Date, timeZone: string): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

export function parseBriefTime(hhmm: string): number | null {
  const m = /^([01]\d|2[0-3]):(00|15|30|45)$/.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** True when the user's local brief time fell within the last `windowMinutes` (inclusive of now). */
export function isBriefDue(user: Pick<User, "timeZone" | "briefTime">, now: Date, windowMinutes = DELIVER_WINDOW_MINUTES): boolean {
  const target = parseBriefTime(user.briefTime) ?? 18 * 60;
  const { minutes } = localClock(now, user.timeZone);
  const sinceTarget = (minutes - target + 1440) % 1440;
  return sinceTarget < windowMinutes;
}

export type DeliverResult =
  | { userId: string; status: "sent"; date: string; publishedId: string }
  | { userId: string; status: "not_due" | "already_sent" }
  | { userId: string; status: "failed"; error: string };

export async function deliverUser(deps: Deps, user: User, now: Date): Promise<DeliverResult> {
  const { date } = localClock(now, user.timeZone);
  try {
    const existing = await deps.store.getBrief(user.id, date);
    if (existing?.sentAt) return { userId: user.id, status: "already_sent" };

    // Catch up on anything poll queued but couldn't process yet. Failures are logged inside.
    await processPending(deps, user.id);

    const model = await deps.buildBrief(deps.store, user, now);
    const markdown = deps.renderMarkdown(model);
    const { id } = await deps.publish(user, model, markdown);
    const sentAt = deps.now().toISOString();
    await deps.store.saveBrief(user.id, date, markdown, sentAt, id);
    await deps.store.logEvent({ userId: user.id, type: "brief_sent", payload: { date, publishedId: id, meetings: model.meetingCount } });
    return { userId: user.id, status: "sent", date, publishedId: id };
  } catch (e) {
    await logJobError(deps, user.id, "deliver", e, { date });
    return { userId: user.id, status: "failed", error: e instanceof Error ? e.name : "Error" };
  }
}

/** Send the brief to every user whose local brief time just passed and who has none sent today. */
export async function deliverDue(deps: Deps, now: Date = deps.now(), opts: { windowMinutes?: number; concurrency?: number } = {}): Promise<DeliverResult[]> {
  const users = await deps.store.listUsers();
  return mapLimit(users, opts.concurrency ?? 4, async (u) => {
    if (!isBriefDue(u, now, opts.windowMinutes)) return { userId: u.id, status: "not_due" as const };
    return deliverUser(deps, u, now);
  });
}
