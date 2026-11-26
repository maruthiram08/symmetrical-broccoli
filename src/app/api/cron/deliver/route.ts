import { NextResponse } from "next/server";
import { isHosted } from "@/server/mode";
import { hostedConfig } from "@/server/hosted/config";
import { cronDeliver, isCronAuthorized, summarize } from "@/server/hosted/jobs";
import { cronRuntime } from "@/server/hosted/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Vercel Cron, every 15 minutes: send each brief whose time has come and that hasn't gone out today.
export async function GET(req: Request) {
  if (!isHosted()) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!isCronAuthorized(req, hostedConfig().cronSecret)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const started = Date.now();
  const runs = await cronDeliver(cronRuntime(), new Date());
  return NextResponse.json({ ...summarize(runs), ms: Date.now() - started });
}
