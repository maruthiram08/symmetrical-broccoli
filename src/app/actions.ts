"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { sendMagicLink, updateUserSettings } from "@/lib/auth";
import { deleteAccount } from "@/lib/actions-apply";
import { verifyToken } from "@/lib/links";
import { clearSessionCookie, readSession } from "@/lib/session-cookie";
import { BRIEF_TIMES, isValidTimeZone } from "./_lib/time";

export async function requestLink(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "");
  const result = await sendMagicLink(email);
  redirect(result.ok ? "/?sent=1" : `/?error=${result.error}`);
}

const setupSchema = z.object({
  name: z.string().trim().max(80),
  timeZone: z.string().refine(isValidTimeZone),
  briefTime: z.string().refine((t) => BRIEF_TIMES.includes(t)),
});

export async function saveSetup(formData: FormData): Promise<void> {
  const uid = await readSession();
  if (!uid) redirect("/");
  const parsed = setupSchema.safeParse({
    name: formData.get("name") ?? "",
    timeZone: formData.get("timeZone") ?? "Asia/Kolkata",
    briefTime: formData.get("briefTime") ?? "18:00",
  });
  if (!parsed.success) redirect("/setup?error=1");
  await updateUserSettings(uid, parsed.data);
  redirect("/api/wispr/connect");
}

export async function confirmDelete(formData: FormData): Promise<void> {
  const p = verifyToken(String(formData.get("token") ?? ""));
  if (!p || p.a !== "delete") redirect("/deleted?expired=1");
  await deleteAccount(p.u);
  if ((await readSession()) === p.u) await clearSessionCookie();
  redirect("/deleted");
}
