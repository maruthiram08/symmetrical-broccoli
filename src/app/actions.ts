"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getStore, me, saveMe, wisprAuthContext } from "@/server/local/app";
import { PENDING_COOKIE, sealPending, startWisprAuth } from "@/server/wispr/oauth";
import { checkNow, startPullSince, startRebuild } from "@/server/local/scheduler";
import { BRIEF_TIMES, isValidTimeZone, startOfDayIso, todayIn } from "./_lib/time";

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
  if (conn?.status === "active" && formData.get("reconnect") !== "1") redirect("/");
  await connectWispr(user!.id);
}

/**
 * Start Wispr Flow sign-in straight from the action. Redirecting a server action to our own
 * /api/wispr/connect makes the client router fetch it, and that fetch can't follow the redirect
 * to Wispr Flow's site; an external URL here makes the browser navigate for real.
 */
async function connectWispr(userId: string): Promise<never> {
  let url: string;
  try {
    const { authorizationUrl, pending } = await startWisprAuth(wisprAuthContext(userId));
    (await cookies()).set(PENDING_COOKIE, sealPending(pending), { httpOnly: true, sameSite: "lax", path: "/api/wispr", maxAge: 600 });
    url = authorizationUrl.toString();
  } catch (e) {
    console.error("[wispr/connect]", e instanceof Error ? e.message : e);
    redirect("/setup?error=wispr");
  }
  redirect(url);
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
  const back = String(formData.get("back") ?? "");
  if (back === "/open" || /^\/people\/[^/?#]+$/.test(back)) redirect(back);
  redirect(p.data.status === "open" ? "/" : `/?undo=${encodeURIComponent(item.id)}&was=${p.data.status}`);
}

export async function checkMeetingsNow(): Promise<void> {
  await checkNow();
  revalidatePath("/");
  redirect("/");
}

/** Settings: pull in every meeting since a date. Runs in the background; Today shows progress. */
export async function pullMeetingsSince(formData: FormData): Promise<void> {
  const user = await me();
  if (!user) redirect("/setup");
  const date = String(formData.get("since") ?? "");
  const since = startOfDayIso(date, user.timeZone);
  if (!since || date > todayIn(user.timeZone)) redirect("/setup?pull=bad");
  startPullSince(user.id, date, since);
  revalidatePath("/");
  redirect("/");
}

/** Settings: read every meeting again, oldest first. */
export async function rereadAllMeetings(): Promise<void> {
  const user = await me();
  if (!user) redirect("/setup");
  startRebuild(user.id);
  revalidatePath("/");
  redirect("/");
}
