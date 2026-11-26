"use server";

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getStore, me } from "@/server/local/app";
import { importNow } from "@/server/local/scheduler";
import { inboxDir } from "@/server/recorders";
import { changeSource, cleanPath, isSourceKey, saveUpload, UploadError } from "@/server/recorders/settings";
import { clearScanCache } from "@/server/recorders/files";
import { errLine } from "@/server/local/log";

/** Settings > Other recorders: one switch per source, submitted on change. */
export async function saveSourceToggle(formData: FormData): Promise<void> {
  const user = await me();
  if (!user) redirect("/welcome");
  const key = formData.get("source");
  if (!isSourceKey(key)) redirect("/setup#sources");
  const enabled = formData.get("enabled") === "on";
  const sources = changeSource(user.sources, key, { enabled }, new Date());
  await getStore().updateUser(user.id, { sources });
  if (enabled && (key === "files" || key === "phone")) {
    try { mkdirSync(inboxDir({ sources }), { recursive: true }); } catch (e) { console.error(`[sources] inbox: ${errLine(e, { message: false })}`); }
  }
  if (enabled) importNow();
  revalidatePath("/setup");
  redirect("/setup#sources");
}

/** Settings: the folder a source reads. Empty goes back to the default. */
export async function saveSourcePath(formData: FormData): Promise<void> {
  const user = await me();
  if (!user) redirect("/welcome");
  const key = formData.get("source");
  if (!isSourceKey(key)) redirect("/setup#sources");
  const raw = String(formData.get("path") ?? "");
  const path = raw.trim() ? cleanPath(raw) : "";
  if (path === null) redirect(`/setup?source=badpath&which=${key}#sources`);
  const sources = changeSource(user.sources, key, { path }, new Date());
  await getStore().updateUser(user.id, { sources });
  clearScanCache();
  if (sources[key]?.enabled) importNow();
  revalidatePath("/setup");
  redirect("/setup#sources");
}

/** Settings: import a downloaded transcript (.docx, .txt, .vtt, .srt, .md) by saving it into the inbox. */
export async function uploadTranscript(formData: FormData): Promise<void> {
  const user = await me();
  if (!user) redirect("/welcome");
  const file = formData.get("file");
  if (!(file instanceof File) || !file.size) redirect("/setup?upload=empty#sources");
  // A phone call goes to inbox/phone/, which always counts as a call.
  const phone = formData.get("kind") === "phone";
  const key = phone ? "phone" : "files";
  let saved = false;
  let reason = "error";
  try {
    saveUpload(phone ? join(inboxDir(user), "phone") : inboxDir(user), file.name, Buffer.from(await file.arrayBuffer()), file.lastModified);
    saved = true;
  } catch (e) {
    if (e instanceof UploadError) reason = e.reason;
    else console.error(`[sources] upload: ${errLine(e, { message: false })}`);
  }
  if (!saved) redirect(`/setup?upload=${reason}#sources`);
  // Uploading is asking for it to be read: turn the inbox on if it was off.
  if (!user.sources?.[key]?.enabled) await getStore().updateUser(user.id, { sources: changeSource(user.sources, key, { enabled: true }, new Date()) });
  importNow();
  revalidatePath("/setup");
  redirect("/setup?upload=ok#sources");
}
