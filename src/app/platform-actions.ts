"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { checkOllama } from "@/lib/extract/ollama";
import { getPhoneStore } from "@/server/local/phone";
import { isRemote, syncPhoneAccess } from "@/server/local/phone-proxy";
import { OLLAMA_MODEL, saveExtractionPrefs, validOllamaUrl } from "@/server/local/prefs";
import { setFlash } from "@/server/local/flash";

/** Phone access, widget tokens and the reading model can only be changed on the Mac itself. */
async function onThisMac(anchor: string): Promise<void> {
  if (isRemote(await headers())) redirect(`/setup?remote=1#${anchor}`);
}

export async function savePhoneAccess(formData: FormData): Promise<void> {
  await onThisMac("phone");
  const on = formData.get("phoneAccess") === "on";
  const phone = getPhoneStore();
  phone.setEnabled(on);
  if (on && !phone.activePairing()) phone.newPairingCode();
  await syncPhoneAccess();
  revalidatePath("/setup");
  redirect("/setup#phone");
}

export async function newPairingCode(): Promise<void> {
  await onThisMac("phone");
  const phone = getPhoneStore();
  if (phone.read().enabled) phone.newPairingCode();
  redirect("/setup#phone");
}

export async function removeDevice(formData: FormData): Promise<void> {
  await onThisMac("phone");
  getPhoneStore().remove(String(formData.get("id") ?? ""));
  redirect(`/setup#${formData.get("back") === "widget" ? "widget" : "phone"}`);
}

export async function forgetAllDevices(): Promise<void> {
  await onThisMac("phone");
  getPhoneStore().removeAll();
  redirect("/setup#phone");
}

export async function createWidgetToken(formData: FormData): Promise<void> {
  await onThisMac("widget");
  const { token } = getPhoneStore().createWidgetToken(String(formData.get("name") ?? "Widget"));
  setFlash("widgetToken", token);
  redirect("/setup#widget");
}

export async function dismissWidgetToken(): Promise<void> {
  setFlash("widgetToken", null);
  redirect("/setup#widget");
}

export async function saveExtraction(formData: FormData): Promise<void> {
  await onThisMac("model");
  const provider = formData.get("provider") === "ollama" ? "ollama" : "claude";
  const model = String(formData.get("ollamaModel") ?? "").trim();
  const url = validOllamaUrl(String(formData.get("ollamaUrl") ?? ""));
  if (provider === "ollama" && (!OLLAMA_MODEL.test(model) || !url)) redirect("/setup?model=bad#model");
  saveExtractionPrefs({ provider, ollamaModel: model || "qwen2.5:14b", ollamaUrl: url ?? "http://127.0.0.1:11434" });
  setFlash("ollamaCheck", formData.get("test") === "1" && url ? JSON.stringify(await checkOllama(url, model)) : null);
  revalidatePath("/setup");
  redirect("/setup#model");
}
