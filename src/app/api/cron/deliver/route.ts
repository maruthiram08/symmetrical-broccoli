import { NextResponse } from "next/server";
import { buildDeps } from "@/server/deps";
import { isCronAuthorized } from "@/server/cron-auth";
import { deliverDue } from "@/server/jobs/deliver";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Every 5 min: send briefs whose local time fell in the last 5 minutes.
export async function GET(req: Request) {
  if (!isCronAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const deps = buildDeps();
  const results = await deliverDue(deps, deps.now());
  const count = (s: string) => results.filter((r) => r.status === s).length;
  return NextResponse.json({ users: results.length, sent: count("sent"), alreadySent: count("already_sent"), failed: count("failed") });
}
