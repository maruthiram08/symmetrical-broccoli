"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { MODE_COOKIE, parseMode, type Mode } from "@/lib/theme/mode";

/** Settings › Appearance: System, Light or Dark. */
export async function setModeAction(mode: Mode): Promise<Mode> {
  const m = parseMode(mode);
  const jar = await cookies();
  if (m === "system") jar.delete(MODE_COOKIE);
  else jar.set(MODE_COOKIE, m, { path: "/", maxAge: 60 * 60 * 24 * 365 * 5, sameSite: "lax", httpOnly: false });
  revalidatePath("/", "layout");
  return m;
}
