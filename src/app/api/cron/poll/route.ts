import { NextResponse } from "next/server";
import { buildDeps } from "@/server/deps";
import { isCronAuthorized } from "@/server/cron-auth";
import { pollAll } from "@/server/jobs/poll";
import { processAllPending } from "@/server/jobs/process";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Every 30 min: queue new meetings for every user, then extract as many as fit in the time budget
// (so the 5-minute deliver job usually has nothing left to process).
export async function GET(req: Request) {
  if (!isCronAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const started = Date.now();
  const deps = buildDeps();
  const polled = await pollAll(deps);
  const processed = await processAllPending(deps, { deadline: started + 240_000 });
  return NextResponse.json({
    users: polled.length,
    pollFailures: polled.filter((r) => !r.ok).length,
    newMeetings: polled.reduce((n, r) => n + (r.ok ? r.created : 0), 0),
    processed: processed.reduce((n, r) => n + r.processed, 0),
    processFailures: processed.reduce((n, r) => n + r.failed, 0),
    ms: Date.now() - started,
  });
}
