"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getStore, me } from "@/server/local/app";

const dueSchema = z.object({ id: z.string().min(1), dueAt: z.string().datetime() });

/** Accept a due-date suggestion from the calendar ("Use this"). */
export async function acceptDue(formData: FormData): Promise<void> {
  const back = String(formData.get("back") ?? "");
  const to = back === "/open" || /^\/(people|series)\/[^/?#]+$/.test(back) ? back : "/";
  const p = dueSchema.safeParse({ id: formData.get("id"), dueAt: formData.get("dueAt") });
  const user = await me();
  if (!p.success || !user) redirect(to);
  const item = (await getStore().listItems(user.id, { status: "open" })).find((i) => i.id === p.data.id);
  if (item) await getStore().setItemDue(user.id, item.id, new Date(p.data.dueAt).toISOString());
  revalidatePath("/");
  redirect(to);
}
