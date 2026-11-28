"use server";

// "Start this": draft on click (never on page load) and record when the user copies or opens a target.
import { z } from "zod";
import { draftsFor, recordHandoff, type DraftsResponse } from "@/server/handoff";

const idSchema = z.string().min(1).max(100);
const targetSchema = z.enum(["slack", "email", "claude"]);

export async function draftHandoffAction(itemId: string): Promise<DraftsResponse> {
  const id = idSchema.safeParse(itemId);
  if (!id.success) return { ok: false, error: "That item is gone." };
  return draftsFor(id.data);
}

/** Returns the "Started in Slack, 10:42 PM" line, or null when nothing was recorded. */
export async function markStartedAction(itemId: string, target: string, how: string): Promise<string | null> {
  const id = idSchema.safeParse(itemId);
  const t = targetSchema.safeParse(target);
  if (!id.success || !t.success) return null;
  return recordHandoff(id.data, t.data, how === "open" ? "open" : "copy");
}
