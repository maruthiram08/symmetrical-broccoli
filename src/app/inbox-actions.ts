"use server";

// Triage for the Inbox: give a captured item a person or a date and put it on its list, or delete it.
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { zonedTime } from "@/lib/brief/time";
import { DUE_TIME } from "@/lib/capture/parse";
import { getStore, me } from "@/server/local/app";

type Result = { ok: true } | { ok: false; error: string };

const fields = z.object({
  kind: z.enum(["owe", "waiting"]),
  person: z.string().trim().max(80).nullable().optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

async function inboxItem(id: string) {
  const user = await me();
  if (!user) return null;
  const item = (await getStore().listItems(user.id)).find((i) => i.id === id && i.status === "inbox");
  return item ? { user, item } : null;
}

/** Move an Inbox item onto You owe or Waiting on, with the person and due date you gave it. */
export async function triageAction(id: string, input: z.input<typeof fields>): Promise<Result> {
  const p = fields.safeParse(input);
  if (!p.success) return { ok: false, error: "Check the person and date." };
  const found = await inboxItem(id);
  if (!found) return { ok: false, error: "That item isn't in the Inbox any more." };
  const { kind, person, dueDate } = p.data;
  const store = getStore();
  await store.updateItem(id, { kind, person: person || null, dueAt: dueDate ? zonedTime(dueDate, DUE_TIME, found.user.timeZone).toISOString() : null });
  await store.setItemStatus(id, "open", new Date().toISOString());
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function deleteInboxAction(id: string): Promise<Result> {
  if (!(await inboxItem(id))) return { ok: false, error: "That item isn't in the Inbox any more." };
  await getStore().deleteItem(id);
  revalidatePath("/", "layout");
  return { ok: true };
}
