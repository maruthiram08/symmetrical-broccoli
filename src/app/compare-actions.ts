"use server";

// Settings › AI › Compare. estimate first (no AI call); run only with the confirmation id the
// estimate returned and an explicit yes from the page. Nothing here runs on its own.
import { headers } from "next/headers";
import { me } from "@/server/local/app";
import { isRemote } from "@/server/local/phone-proxy";
import { isHosted } from "@/server/mode";
import { estimateCompare, parsePairs, runCompare, type CompareEstimate, type CompareResult } from "@/server/compare";

export async function estimateCompareAction(meetingId: string, raw: Array<{ provider: string; model: string }>): Promise<{ ok: true; estimate: CompareEstimate } | { ok: false; error: string }> {
  if (isRemote(await headers())) return { ok: false, error: "Compare runs on your computer, not from a paired phone." };
  const user = await me();
  if (!user) return { ok: false, error: "Set up Daily brief first." };
  if (typeof meetingId !== "string" || !meetingId || !Array.isArray(raw)) return { ok: false, error: "Pick a meeting." };
  const pairs = parsePairs(raw.slice(0, 3), isHosted());
  if (typeof pairs === "string") return { ok: false, error: pairs };
  try {
    return { ok: true, estimate: await estimateCompare(user, meetingId, pairs) };
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    return { ok: false, error: name === "ReconnectRequiredError" ? "Wispr Flow signed you out. Reconnect it, then try again." : "Couldn't get that meeting's transcript. Try another meeting." };
  }
}

export async function runCompareAction(confirmId: string, confirmed: boolean): Promise<{ ok: true; result: CompareResult } | { ok: false; error: string }> {
  if (isRemote(await headers())) return { ok: false, error: "Compare runs on your computer, not from a paired phone." };
  if (confirmed !== true) return { ok: false, error: "Confirm the cost first." };
  const user = await me();
  if (!user) return { ok: false, error: "Set up Daily brief first." };
  if (typeof confirmId !== "string") return { ok: false, error: "Estimate first." };
  const r = await runCompare(user, confirmId);
  return typeof r === "string" ? { ok: false, error: r } : { ok: true, result: r };
}
