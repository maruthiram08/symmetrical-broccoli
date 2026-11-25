"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getStore, me, saveMe } from "@/server/local/app";
import { checkNow } from "@/server/local/scheduler";
import { BRIEF_TIMES, isValidTimeZone } from "./_lib/time";

const setupSchema = z.object({
  name: z.string().trim().min(1).max(80),
  aliases: z.string().max(200),
  timeZone: z.string().refine(isValidTimeZone),
  briefTime: z.string().refine((t) => BRIEF_TIMES.includes(t)),
});

export async function saveSetup(formData: FormData): Promise<void> {
  const parsed = setupSchema.safeParse({
    name: formData.get("name") ?? "",
    aliases: formData.get("aliases") ?? "",
    timeZone: formData.get("timeZone") ?? "Asia/Kolkata",
    briefTime: formData.get("briefTime") ?? "18:00",
  });
  if (!parsed.success) redirect("/setup?error=1");
  const { aliases, ...rest } = parsed.data;
  await saveMe({ ...rest, aliases: aliases.split(",").map((a) => a.trim()).filter(Boolean) });
  const user = await me();
  const conn = user ? await getStore().getConnection(user.id) : null;
  redirect(conn?.status === "active" && formData.get("reconnect") !== "1" ? "/" : "/api/wispr/connect");
}

const statusSchema = z.object({ id: z.string().min(1), status: z.enum(["open", "done", "wrong"]) });

/** Done, Wrong and Undo on the Today screen. */
export async function setStatus(formData: FormData): Promise<void> {
  const p = statusSchema.safeParse({ id: formData.get("id"), status: formData.get("status") });
  if (!p.success) redirect("/");
  const user = await me();
  const store = getStore();
  const item = (await store.listItems(user?.id ?? "")).find((i) => i.id === p.data.id);
  if (!item) redirect("/");
  await store.setItemStatus(item.id, p.data.status, new Date().toISOString());
  revalidatePath("/");
  redirect(p.data.status === "open" ? "/" : `/?undo=${encodeURIComponent(item.id)}&was=${p.data.status}`);
}

export async function checkMeetingsNow(): Promise<void> {
  await checkNow();
  revalidatePath("/");
  redirect("/");
}
