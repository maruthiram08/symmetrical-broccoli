"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getFileStore, me } from "@/server/local/app";
import { isHosted } from "@/server/mode";
import { saveCrosscheckEnabled } from "@/server/crosscheck/core";
import { startCrossAll } from "@/server/crosscheck/all";

/** Settings › AI: the "Cross-check with Wispr Flow" switch. */
export async function saveCrosscheckSettingAction(formData: FormData): Promise<void> {
  if (isHosted()) return;
  saveCrosscheckEnabled(formData.get("crosscheck") === "on");
  revalidatePath("/setup");
  revalidatePath("/crosscheck");
}

export async function crossCheckAllAction(): Promise<void> {
  const user = await me();
  if (!user || isHosted()) return;
  await startCrossAll(user.id);
  redirect("/crosscheck");
}

function target(formData: FormData): { meetingId: string; index: number } | null {
  const meetingId = String(formData.get("meetingId") ?? "");
  const index = Number(formData.get("index"));
  return meetingId && Number.isInteger(index) && index >= 0 ? { meetingId, index } : null;
}

/** "Add as You owe" / "Add as Waiting on": a manual item linked to the meeting, with Wispr's wording. */
export async function addFromCrossCheckAction(formData: FormData): Promise<void> {
  const user = await me();
  const t = target(formData);
  const kind = formData.get("kind") === "waiting" ? "waiting" : "owe";
  if (!user || !t || isHosted()) return;
  const store = getFileStore();
  const rec = await store.getCrossCheck(t.meetingId);
  const e = rec?.userId === user.id ? rec.entries[t.index] : undefined;
  if (!e || e.verdict !== "missed" || e.addedItemId) return;
  const person = e.person ?? (kind === "waiting" ? e.wispr.owner : null);
  const item = await store.addManualItem(user.id, { kind, text: e.wispr.text, person: person || null, dueAt: null, meetingId: t.meetingId }, new Date().toISOString());
  await store.updateCrossCheck(t.meetingId, (r) => {
    const x = r.entries[t.index];
    if (!x || x.addedItemId) return false;
    x.addedItemId = item.id;
    return true;
  });
  revalidatePath("/crosscheck");
  revalidatePath(`/meeting/${encodeURIComponent(t.meetingId)}`);
}

export async function ignoreCrossCheckAction(formData: FormData): Promise<void> {
  const user = await me();
  const t = target(formData);
  if (!user || !t || isHosted()) return;
  await getFileStore().updateCrossCheck(t.meetingId, (r) => {
    const x = r.userId === user.id ? r.entries[t.index] : undefined;
    if (!x || x.ignored) return false;
    x.ignored = true;
    return true;
  });
  revalidatePath("/crosscheck");
  revalidatePath(`/meeting/${encodeURIComponent(t.meetingId)}`);
}
