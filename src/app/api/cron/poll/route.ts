import { NextResponse } from "next/server";
import { isHosted } from "@/server/mode";
import { hostedConfig } from "@/server/hosted/config";
import { cronPoll, isCronAuthorized, summarize } from "@/server/hosted/jobs";
import { cronRuntime } from "@/server/hosted/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Vercel Cron, every 30 minutes: new meetings for every user, read as many as fit.
export async function GET(req: Request) {
  if (!isHosted()) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!isCronAuthorized(req, hostedConfig().cronSecret)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const started = Date.now();
  const runs = await cronPoll(cronRuntime(), { deadline: started + (maxDuration - 60) * 1000 });
  return NextResponse.json({ ...summarize(runs), ms: Date.now() - started });
}
