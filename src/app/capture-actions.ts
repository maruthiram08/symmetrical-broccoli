"use server";

// Your own items, stars, snoozes and day notes. Called from client components, which refresh after.
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { addDays, localDate, zonedTime } from "@/lib/brief/time";
import { DUE_TIME } from "@/lib/capture/parse";
import { isManual } from "@/lib/capture/items";
import { normalizeName } from "@/lib/people";
import { listPeople } from "@/lib/people";
import { getStore, me } from "@/server/local/app";
import { saveDayNotes } from "@/server/local/notes";
import { loadAll } from "./_lib/lines";

type Result = { ok: true; id?: string } | { ok: false; error: string };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const fields = z.object({
  kind: z.enum(["owe", "waiting"]),
  text: z.string().trim().min(1, "Say what it is.").max(300),
  person: z.string().trim().max(80).nullable().optional(),
  dueDate: z.string().regex(DATE).nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
});

async function mine(id: string) {
  const user = await me();
  if (!user) return null;
  const item = (await getStore().listItems(user.id)).find((i) => i.id === id);
  return item ? { user, item } : null;
}

const done = (r: Result): Result => { revalidatePath("/", "layout"); return r; };

/** Add an item by hand. */
export async function addItemAction(input: z.input<typeof fields>): Promise<Result> {
  const p = fields.safeParse(input);
  if (!p.success) return { ok: false, error: p.error.issues[0]?.message ?? "Check the fields." };
  const user = await me();
  if (!user) return { ok: false, error: "Set up Daily brief first." };
  const { kind, text, person, dueDate, note } = p.data;
  const item = await getStore().addManualItem(user.id, {
    kind, text, person: person || null, note: note || null,
    dueAt: dueDate ? zonedTime(dueDate, DUE_TIME, user.timeZone).toISOString() : null,
  }, new Date().toISOString());
  return done({ ok: true, id: item.id });
}

/** Edit one of your own items. */
export async function updateItemAction(id: string, input: z.input<typeof fields>): Promise<Result> {
  const p = fields.safeParse(input);
  if (!p.success) return { ok: false, error: p.error.issues[0]?.message ?? "Check the fields." };
  const found = await mine(id);
  if (!found || !isManual(found.item)) return { ok: false, error: "Only items you added can be edited." };
  const { kind, text, person, dueDate, note } = p.data;
  await getStore().updateItem(id, {
    kind, text, person: person || null, note: note || null,
    dueAt: dueDate ? zonedTime(dueDate, DUE_TIME, found.user.timeZone).toISOString() : null,
  });
  return done({ ok: true, id });
}

/** Delete one of your own items (meeting items are marked Wrong instead). */
export async function deleteItemAction(id: string): Promise<Result> {
  const found = await mine(id);
  if (!found || !isManual(found.item)) return { ok: false, error: "Only items you added can be deleted." };
  await getStore().deleteItem(id);
  return done({ ok: true });
}

export async function setStarAction(id: string, starred: boolean): Promise<Result> {
  if (!(await mine(id))) return { ok: false, error: "That item is gone." };
  await getStore().updateItem(id, { starred });
  return done({ ok: true, id });
}

/** Hide an item until a local date; null brings it back now. */
export async function snoozeAction(id: string, until: string | null): Promise<Result> {
  const found = await mine(id);
  if (!found) return { ok: false, error: "That item is gone." };
  if (until !== null && (!DATE.test(until) || until <= localDate(new Date(), found.user.timeZone))) return { ok: false, error: "Pick a day after today." };
  await getStore().updateItem(id, { snoozedUntil: until });
  return done({ ok: true, id });
}

/** Snooze choices as local dates in your zone (this Mac's clock may be in another). */
export async function snoozeDatesAction(): Promise<{ today: string; tomorrow: string; monday: string; week: string } | null> {
  const user = await me();
  if (!user) return null;
  const today = localDate(new Date(), user.timeZone);
  const [y, m, d] = today.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return { today, tomorrow: addDays(today, 1), monday: addDays(today, ((8 - dow) % 7) || 7), week: addDays(today, 7) };
}

/** What quick capture needs to parse locally: known people, your names, your zone. */
export async function captureContextAction(): Promise<{ people: string[]; self: string[]; timeZone: string } | null> {
  const user = await me();
  if (!user) return null;
  const { items, meetings } = await loadAll(user);
  const self = [user.name, ...user.aliases].filter(Boolean);
  const skip = new Set(self.map(normalizeName));
  const people = listPeople({ items, meetings, now: new Date(), self }).map((p) => p.name);
  for (const m of meetings) for (const p of m.participants) if (!p.includes("@") && !skip.has(normalizeName(p))) people.push(p);
  return { people: [...new Set(people)], self, timeZone: user.timeZone };
}

/** Autosave for the notes section of a daily note. */
export async function saveDayNotesAction(date: string, notes: string): Promise<Result> {
  if (!DATE.test(date) || notes.length > 100_000) return { ok: false, error: "Couldn't save." };
  const user = await me();
  if (!user) return { ok: false, error: "Set up Daily brief first." };
  try {
    await saveDayNotes(user.id, date, notes);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't save." };
  }
  return { ok: true };
}
