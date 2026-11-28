import { blockFileName, blockIcs, nextFreeSlot } from "@/lib/calendar/block";
import { freshEvents } from "@/lib/calendar/series";
import { getStore, me } from "@/server/local/app";

export const dynamic = "force-dynamic";

/**
 * "Block 30 min" on a thing you owe: an .ics file for the next free half hour in working hours,
 * worked out from the cached calendar. Nothing is written to any calendar; you open the file.
 */
export async function GET(req: Request): Promise<Response> {
  const id = new URL(req.url).searchParams.get("id") ?? "";
  const user = await me();
  if (!user) return new Response("Not set up", { status: 404 });
  const store = getStore();
  const item = (await store.listItems(user.id, { status: "open" })).find((i) => i.id === id && i.kind === "owe");
  if (!item) return new Response("No such open item", { status: 404 });
  const now = new Date();
  const slot = nextFreeSlot(freshEvents(await store.getCalendar(user.id), now), now, user.timeZone);
  if (!slot) return new Response("No free 30 minutes in the next two weeks", { status: 409 });
  const ics = blockIcs({
    uid: `${item.id}-${slot.start.getTime()}@daily-brief.local`,
    title: item.text,
    description: [item.person ? `For ${item.person}.` : "", item.quote ? `"${item.quote}"` : "", "From Daily brief."].filter(Boolean).join("\n"),
    start: slot.start, end: slot.end, now,
  });
  return new Response(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="${blockFileName(item.text)}"`,
      "Cache-Control": "no-store",
    },
  });
}
