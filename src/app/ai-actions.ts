"use server";

// Contradiction catch: Keep both / Mark old as replaced.
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { resolveContradiction } from "@/server/ai";
import { me } from "@/server/local/app";

export async function resolveContradictionAction(formData: FormData): Promise<void> {
  const id = z.string().min(1).max(100).safeParse(formData.get("id"));
  const how = z.enum(["keep", "replace"]).safeParse(formData.get("how"));
  const user = await me();
  if (!id.success || !how.success || !user) return;
  await resolveContradiction(user, id.data, how.data);
  revalidatePath("/");
}
