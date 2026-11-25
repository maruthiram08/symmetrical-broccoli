import type { Item, Meeting } from "@/lib/types";
import type { Store } from "@/server/store";

/** Everything the wrap, week and close-moment views read: the user's items (minus "wrong") and meetings. */
export interface BriefData {
  items: Item[];
  meetings: Meeting[];
}

export async function loadBriefData(store: Store, userId: string): Promise<BriefData> {
  const items = (await store.listItems(userId)).filter((i) => i.status !== "wrong");
  const meetings = await store.listMeetingsBetween(userId, "0000", "9999");
  return { items, meetings };
}

/** Meeting by id, for pure functions. */
export function meetingIndex(meetings: Meeting[]): (id: string | null) => Meeting | null {
  const byId = new Map(meetings.map((m) => [m.id, m]));
  return (id) => (id ? byId.get(id) ?? null : null);
}

/** "23 Nov" in the user's zone. */
export function shortDay(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone });
}
