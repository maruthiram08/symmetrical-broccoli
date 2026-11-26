"use server";

// The people directory: Check names, merge, split and edit. Each change can be undone.
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { confirmMany, confirmNew, editPerson, ignoreNames, merge, moveItems, type NameRef } from "@/lib/directory/directory";
import { getStore, me } from "@/server/local/app";

export type PeopleResult = { ok: true; changeId: string | null; label: string } | { ok: false; error: string };

const name = z.string().trim().min(1).max(80);
const spellings = z.array(name).min(1).max(50);
const ref = z.union([
  z.object({ personId: z.string().min(1).max(80) }),
  z.object({ name, spellings: z.array(name).max(50).optional() }),
]);
const email = z.string().trim().max(200).email("That email doesn't look right.").or(z.literal("")).nullable().optional();

async function run(plan: Parameters<ReturnType<typeof getStore>["changePeople"]>[1]): Promise<PeopleResult> {
  const user = await me();
  if (!user) return { ok: false, error: "Set up Daily brief first." };
  try {
    const c = await getStore().changePeople(user.id, plan, new Date().toISOString());
    revalidatePath("/", "layout");
    return { ok: true, changeId: c?.id ?? null, label: c?.label ?? "Nothing to change" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't save." };
  }
}

const bad = (e: z.ZodError): PeopleResult => ({ ok: false, error: e.issues[0]?.message ?? "Check the fields." });

/** "Same as …": these names (or this person) mean the target person. */
export async function mergeAction(source: z.input<typeof ref>, into: z.input<typeof ref>): Promise<PeopleResult> {
  const s = ref.safeParse(source), t = ref.safeParse(into);
  if (!s.success) return bad(s.error);
  if (!t.success) return bad(t.error);
  return run((d, ctx) => merge(d, s.data as NameRef, t.data as NameRef, ctx));
}

/** "New person" (and "Rename"): these spellings are one person, shown as `name`. */
export async function confirmPersonAction(input: { name: string; spellings: string[]; email?: string | null }): Promise<PeopleResult> {
  const p = z.object({ name, spellings, email }).safeParse(input);
  if (!p.success) return bad(p.error);
  return run((d, ctx) => confirmNew(d, p.data, ctx));
}

/** Confirm every listed name as it is (the names with no look-alike), as one undoable change. */
export async function confirmManyAction(names: Array<{ name: string; spellings: string[] }>): Promise<PeopleResult> {
  const p = z.array(z.object({ name, spellings })).min(1).max(500).safeParse(names);
  if (!p.success) return bad(p.error);
  return run((d, ctx) => confirmMany(d, p.data, ctx));
}

/** "Not a person": transcription noise. */
export async function ignoreNamesAction(input: { spellings: string[] }): Promise<PeopleResult> {
  const p = z.object({ spellings }).safeParse(input);
  if (!p.success) return bad(p.error);
  return run((d, ctx) => ignoreNames(d, p.data.spellings, ctx));
}

/** Split: move these items to another person. */
export async function moveItemsAction(itemIds: string[], to: z.input<typeof ref>): Promise<PeopleResult> {
  const ids = z.array(z.string().min(1).max(80)).min(1, "Pick the items to move.").max(500).safeParse(itemIds);
  const t = ref.safeParse(to);
  if (!ids.success) return bad(ids.error);
  if (!t.success) return bad(t.error);
  const user = await me();
  if (!user) return { ok: false, error: "Set up Daily brief first." };
  const mine = new Set((await getStore().listItems(user.id)).map((i) => i.id));
  if (!ids.data.every((id) => mine.has(id))) return { ok: false, error: "Some of those items are gone." };
  return run((d, ctx) => moveItems(d, ids.data, t.data as NameRef, ctx));
}

/** Edit a confirmed person's name, email or note. */
export async function editPersonAction(id: string, patch: { name?: string; email?: string | null; note?: string | null }): Promise<PeopleResult> {
  const p = z.object({ name: name.optional(), email, note: z.string().max(1000).nullable().optional() }).safeParse(patch);
  if (!p.success) return bad(p.error);
  return run((d, ctx) => editPerson(d, id, p.data, ctx));
}

/** Undo one change. */
export async function undoPeopleAction(changeId: string): Promise<PeopleResult> {
  const user = await me();
  if (!user) return { ok: false, error: "Set up Daily brief first." };
  const c = await getStore().undoPeopleChange(user.id, String(changeId).slice(0, 80));
  revalidatePath("/", "layout");
  return c ? { ok: true, changeId: c.id, label: `Undid: ${c.label}` } : { ok: false, error: "Nothing to undo." };
}
