import { dateLabel } from "@/lib/brief/time";
import { getStore } from "@/server/local/app";

/** Past daily notes for the sidebar, newest first. */
export async function pastDays(userId: string, today: string) {
  const briefs = await getStore().listBriefs(userId);
  return briefs
    .map((b) => b.date)
    .filter((d) => d !== today)
    .sort()
    .reverse()
    .slice(0, 14)
    .map((date) => ({ date, label: dateLabel(date).replace(/, (\d+) (\w{3})\w*$/, ", $1 $2") }));
}
