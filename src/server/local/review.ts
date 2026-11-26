import { buildReview, periodFor, type PeriodKind, type Review } from "@/lib/review/review";
import type { User } from "@/lib/types";
import { getStore } from "./app";

/** A month or year review for the local user, or null when the key isn't a month/year. */
export async function loadReview(user: User, kind: PeriodKind, key: string, now = new Date()): Promise<Review | null> {
  const period = periodFor(kind, key, user.timeZone);
  if (!period) return null;
  const store = getStore();
  const [items, meetings] = await Promise.all([store.listItems(user.id), store.listMeetingsBetween(user.id, "0000", "9999")]);
  return buildReview({ items, meetings, user, period, now });
}
