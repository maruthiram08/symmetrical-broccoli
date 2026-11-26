"use server";

// Routines (src/lib/routines): add, edit, archive and delete; tick, skip and snooze one occurrence;
// add or dismiss a suggestion from a meeting. Local only for now: the hosted store has no routines.
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { addDays, localDate } from "@/lib/brief/time";
import { checkRoutineInput, type RoutineInput } from "@/lib/routines/input";
import { openOccurrences } from "@/lib/routines/schedule";
import type { Routine } from "@/lib/routines/types";
import { getStore, me } from "@/server/local/app";
import { routineStore } from "@/server/routines";

type Result = { ok: true; id?: string } | { ok: false; error: string };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const NO_ROUTINES = "Routines aren't available here yet.";

async function ctx() {
  const user = await me();
  const rs = routineStore(getStore());
  return user && rs ? { user, rs } : null;
}

async function mine(id: string) {
  const c = await ctx();
  const r = c ? (await c.rs.listRoutines(c.user.id)).find((x) => x.id === id) : undefined;
  return c && r ? { ...c, routine: r } : null;
}

const done = (r: Result): Result => { revalidatePath("/", "layout"); return r; };

export async function addRoutineAction(input: RoutineInput): Promise<Result> {
  const p = checkRoutineInput(input);
  if (!p.ok) return p;
  const c = await ctx();
  if (!c) return { ok: false, error: NO_ROUTINES };
  const r: Routine = { id: randomUUID(), userId: c.user.id, ...p.value, createdAt: new Date().toISOString(), archived: false, source: { type: "manual" } };
  await c.rs.saveRoutine(r);
  return done({ ok: true, id: r.id });
}

export async function updateRoutineAction(id: string, input: RoutineInput): Promise<Result> {
  const p = checkRoutineInput(input);
  if (!p.ok) return p;
  const f = await mine(id);
  if (!f) return { ok: false, error: "That routine is gone." };
  await f.rs.saveRoutine({ ...f.routine, ...p.value });
  return done({ ok: true, id });
}

export async function archiveRoutineAction(id: string, archived: boolean): Promise<Result> {
  const f = await mine(id);
  if (!f) return { ok: false, error: "That routine is gone." };
  await f.rs.saveRoutine({ ...f.routine, archived });
  return done({ ok: true, id });
}

export async function deleteRoutineAction(id: string): Promise<Result> {
  const c = await ctx();
  if (!c || !(await c.rs.deleteRoutine(c.user.id, id))) return { ok: false, error: "That routine is gone." };
  return done({ ok: true });
}

/** Today's tick, Skip and Undo, from a plain form: routine, date, status ("done" | "skipped" | "clear"). */
export async function markOccurrenceAction(form: FormData): Promise<void> {
  const id = String(form.get("routine") ?? ""), date = String(form.get("date") ?? ""), status = String(form.get("status") ?? "");
  if (!DATE.test(date) || !["done", "skipped", "clear"].includes(status)) return;
  const f = await mine(id);
  if (!f) return;
  const at = new Date().toISOString();
  // Ticking or skipping the row closes that one occurrence: the next one comes back on schedule.
  await f.rs.setOccurrence(f.user.id, id, date, status === "clear" ? null : { status: status as "done" | "skipped" }, at);
  done({ ok: true });
}

/** Snooze what's open of a routine today until a later local date ("tomorrow" by default). */
export async function snoozeOccurrenceAction(form: FormData): Promise<void> {
  const id = String(form.get("routine") ?? "");
  const f = await mine(id);
  if (!f) return;
  const today = localDate(new Date(), f.user.timeZone);
  const until = String(form.get("until") ?? "") || addDays(today, 1);
  if (!DATE.test(until) || until <= today) return;
  const at = new Date().toISOString();
  for (const date of openOccurrences(f.routine, await f.rs.listOccurrences(f.user.id), today, f.user.timeZone)) {
    await f.rs.setOccurrence(f.user.id, id, date, { status: "snoozed", until }, at);
  }
  done({ ok: true });
}

/** Add a suggestion from a meeting as a routine (as suggested, or as edited). */
export async function addSuggestionAction(id: string, input?: RoutineInput): Promise<Result> {
  const c = await ctx();
  if (!c) return { ok: false, error: NO_ROUTINES };
  const s = (await c.rs.listRoutineSuggestions(c.user.id)).find((x) => x.id === id && x.status === "open");
  if (!s) return { ok: false, error: "That suggestion is gone." };
  const p = checkRoutineInput(input ?? { title: s.title, cadence: s.cadence, time: s.time, person: s.person });
  if (!p.ok) return p;
  const r: Routine = {
    id: randomUUID(), userId: c.user.id, ...p.value, createdAt: new Date().toISOString(), archived: false,
    source: { type: "meeting", meetingId: s.meetingId, quote: s.quote },
  };
  await c.rs.saveRoutine(r);
  await c.rs.setRoutineSuggestionStatus(c.user.id, id, "added");
  return done({ ok: true, id: r.id });
}

export async function dismissSuggestionAction(id: string): Promise<Result> {
  const c = await ctx();
  if (!c || !(await c.rs.setRoutineSuggestionStatus(c.user.id, id, "dismissed"))) return { ok: false, error: "That suggestion is gone." };
  return done({ ok: true });
}

/** Today in your zone, for the editor's "every N days" start. */
export async function routineTodayAction(): Promise<string | null> {
  const user = await me();
  return user ? localDate(new Date(), user.timeZone) : null;
}
