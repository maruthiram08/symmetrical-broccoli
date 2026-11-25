"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { buildDeps, getStore, me, saveMe, wisprAuthContext } from "@/server/local/app";
import { estimateRead, type ReadEstimate } from "@/server/jobs/estimate";
import { PENDING_COOKIE, sealPending, startWisprAuth } from "@/server/wispr/oauth";
import { checkNow, retryReading, startPullSince, startRebuild } from "@/server/local/scheduler";
import { BRIEF_TIMES, isValidTimeZone, startOfDayIso, todayIn } from "./_lib/time";
import { errLine } from "@/server/local/log";

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
  const welcome = formData.get("next") === "welcome";
  if (!parsed.success) redirect(welcome ? "/welcome?error=1" : "/setup?error=1");
  const { aliases, ...rest } = parsed.data;
  await saveMe({ ...rest, aliases: aliases.split(",").map((a) => a.trim()).filter(Boolean) });
  // First run: step 1 of /welcome only saves; connecting is its own step.
  if (welcome) redirect("/welcome");
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
/** Step 2 of /welcome: sign in to Wispr Flow. The callback brings you back to step 3. */
export async function connectWisprFlow(): Promise<void> {
  const user = await me();
  if (!user) redirect("/welcome");
  await connectWispr(user.id, "/welcome?error=wispr");
}

async function connectWispr(userId: string, onError = "/setup?error=wispr"): Promise<never> {
  let url: string;
  try {
    const { authorizationUrl, pending } = await startWisprAuth(wisprAuthContext(userId));
    (await cookies()).set(PENDING_COOKIE, sealPending(pending), { httpOnly: true, sameSite: "lax", path: "/api/wispr", maxAge: 600 });
    url = authorizationUrl.toString();
  } catch (e) {
    console.error(`[wispr/connect] ${errLine(e)}`);
    redirect(onError);
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

/**
 * Settings: "Include meetings others shared with me". Turning it on offers to pull the shared
 * meetings you already have (only new ones come in on their own).
 */
export async function saveIncludeShared(formData: FormData): Promise<void> {
  const user = await me();
  if (!user) redirect("/welcome");
  const on = formData.get("includeShared") === "on";
  const was = user.includeShared === true; // read first: updateUser changes the same object
  await getStore().updateUser(user.id, { includeShared: on });
  revalidatePath("/");
  redirect(on && !was ? "/setup?shared=on" : "/setup");
}

export type EstimateResult = ({ ok: true } & ReadEstimate) | { ok: false; error: string };

/** /welcome step 3: count what "read meetings since" would read, before anything is read. */
export async function estimateMeetingsSince(date: string, includeShared: boolean): Promise<EstimateResult> {
  const user = await me();
  if (!user) return { ok: false, error: "Set up your name first." };
  const since = startOfDayIso(String(date), user.timeZone);
  if (!since || date > todayIn(user.timeZone)) return { ok: false, error: "Pick a date that isn't in the future." };
  const conn = await getStore().getConnection(user.id);
  if (conn?.status !== "active") return { ok: false, error: "Connect Wispr Flow first." };
  try {
    return { ok: true, ...(await estimateRead(buildDeps(), user.id, since, { includeShared: includeShared === true })) };
  } catch (e) {
    console.error("[estimate]", e instanceof Error ? e.name : "Error");
    return { ok: false, error: "Couldn't reach Wispr Flow to count your meetings." };
  }
}

/** /welcome step 3: save the shared-meetings choice and start the first read (the pull-since flow). */
export async function startFirstRead(formData: FormData): Promise<void> {
  const user = await me();
  if (!user) redirect("/welcome");
  const date = String(formData.get("since") ?? "");
  const since = startOfDayIso(date, user.timeZone);
  if (!since || date > todayIn(user.timeZone)) redirect("/welcome?pull=bad");
  await getStore().updateUser(user.id, { includeShared: formData.get("includeShared") === "on" });
  startPullSince(user.id, date, since);
  redirect("/welcome");
}

/** Banner: read the meetings that couldn't be read again (after fixing the key or adding credit). */
export async function retryFailedMeetings(): Promise<void> {
  const user = await me();
  if (!user) redirect("/setup");
  await retryReading(user.id);
  revalidatePath("/", "layout");
  redirect("/");
}

/** Banner: hide the "restored from backup" notice. */
export async function dismissRecoveryNotice(formData: FormData): Promise<void> {
  await getStore().dismissRecovery();
  revalidatePath("/", "layout");
  const back = String(formData.get("back") ?? "/");
  redirect(back.startsWith("/") && !back.startsWith("//") ? back : "/");
}
