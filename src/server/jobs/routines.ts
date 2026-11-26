// Promises the user says they'll keep making ("every Monday I'll send the report") become routine
// suggestions on /routines, not one-off items. Nothing becomes a routine until the user taps Add.
import { localDate } from "@/lib/brief/time";
import { parseCadence } from "@/lib/routines/parse";
import { QUOTE_MAX, type ExtractionResult, type Meeting, type User } from "@/lib/types";
import { routineStore } from "@/server/routines";

type NewItem = ExtractionResult["newItems"][number];

/**
 * Save a suggestion for each recurring owe item whose cadence words can be read, and return those
 * items so the caller leaves them out of the meeting's items. On a store without routines (hosted,
 * for now) nothing changes: the items stay ordinary items.
 */
export async function suggestRoutines(store: unknown, meeting: Pick<Meeting, "id" | "startedAt">, user: Pick<User, "id" | "timeZone">, items: NewItem[], now: Date): Promise<Set<NewItem>> {
  const taken = new Set<NewItem>();
  const rs = routineStore(store);
  if (!rs) return taken;
  const anchor = localDate(new Date(meeting.startedAt), user.timeZone);
  const out: Parameters<typeof rs.addRoutineSuggestions>[1] = [];
  for (const n of items) {
    if (n.kind !== "owe" || !n.recurrence?.trim()) continue;
    const c = parseCadence(n.recurrence, anchor) ?? parseCadence(n.quote, anchor);
    if (!c) continue; // words we can't read: keep it as an item rather than lose it
    taken.add(n);
    out.push({
      title: n.text, cadence: c.cadence, time: c.time, person: n.person, meetingId: meeting.id,
      quote: n.quote.slice(0, QUOTE_MAX), recurrence: n.recurrence.trim().slice(0, 80), createdAt: now.toISOString(),
    });
  }
  if (out.length) await rs.addRoutineSuggestions(user.id, out);
  return taken;
}
