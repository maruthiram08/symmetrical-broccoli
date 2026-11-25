import Link from "next/link";
import { cache } from "react";
import { acceptDue } from "@/app/calendar-actions";
import { formatTime } from "@/lib/brief/time";
import type { BriefLine } from "@/lib/types";
import { getStore, me } from "@/server/local/app";
import { dueHintsFor } from "@/server/local/calendar";

/** Due hints for the whole page, worked out once per request. */
const pageHints = cache(async () => {
  const user = await me();
  if (!user) return null;
  try {
    return { user, hints: await dueHintsFor(getStore(), user, new Date()) };
  } catch (e) {
    console.error("[calendar] hints", e instanceof Error ? e.name : "Error");
    return null;
  }
});

/** "Thu 26 Nov, 11:00 AM" */
function when(iso: string, timeZone: string): string {
  const day = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short" }).format(new Date(iso));
  return `${day}, ${formatTime(iso, timeZone)}`;
}

/** A dim "Due at the next Standup, Thu 26 Nov, 11:00 AM? Use it" under an item, when the calendar suggests one. */
export async function DueHintRow({ line, back }: { line: BriefLine; back?: string }) {
  if (line.kind === "decision") return null;
  const page = await pageHints();
  const h = page?.hints.get(line.itemId);
  if (!h || !page) return null;
  return (
    <form action={acceptDue} className="cal-hint">
      <input type="hidden" name="id" value={h.itemId} />
      <input type="hidden" name="dueAt" value={h.dueAt} />
      {back ? <input type="hidden" name="back" value={back} /> : null}
      <span className="cal-hint__text">
        {h.reason === "named" ? "Said before the next " : line.dueLabel || line.lateLabel ? "Next meeting with them: " : "No due date. Next "}
        <Link className="cal-hint__series" href={`/series/${h.seriesId}`}>{h.seriesTitle}</Link>
        {h.reason === "named" ? ", " : line.dueLabel || line.lateLabel ? ", " : " is "}
        {when(h.dueAt, page.user.timeZone)}
      </span>
      <button className="cal-hint__use" type="submit">Use this</button>
    </form>
  );
}

/** "Block 30 min": downloads an .ics for the next free half hour. Only on things you owe. */
export function BlockLink({ line }: { line: BriefLine }) {
  if (line.kind !== "owe") return null;
  return (
    <a className="db-act cal-block" href={`/api/block?id=${encodeURIComponent(line.itemId)}`} download title="Download a calendar file for the next free 30 minutes (10 AM to 7 PM)">
      Block 30 min
    </a>
  );
}
