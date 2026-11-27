"use server";

// Recurring: rename a series, or say it is not one. Both live in series.json and can be undone.
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { me } from "@/server/local/app";
import { MAX_SERIES_NAME, renameSeries, setSeriesHidden } from "@/server/local/series-names";

const keySchema = z.string().regex(/^(slot|id):[^\s]{1,120}$/);

export async function renameSeriesAction(key: string, name: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(await me())) return { ok: false, error: "Set up the app first." };
  const k = keySchema.safeParse(key);
  const n = z.string().max(MAX_SERIES_NAME * 2).safeParse(name);
  if (!k.success || !n.success) return { ok: false, error: "That name didn't save. Try a shorter one." };
  renameSeries(k.data, n.data);
  revalidatePath("/series", "layout");
  return { ok: true };
}

export async function hideSeriesAction(key: string, on: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(await me())) return { ok: false, error: "Set up the app first." };
  const k = keySchema.safeParse(key);
  if (!k.success) return { ok: false, error: "That series is gone." };
  setSeriesHidden(k.data, on);
  revalidatePath("/series", "layout");
  return { ok: true };
}
