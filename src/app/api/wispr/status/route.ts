import { NextResponse } from "next/server";
import { getStore } from "@/server/deps";
import { backfillSummary } from "@/server/jobs/backfill";
import { getSessionUserId } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// For the Connected page: connection state plus backfill totals ({ meetings, promisesMade, stillOpen, done }).
export async function GET(req: Request) {
  const userId = getSessionUserId(req);
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const store = getStore();
  const conn = await store.getConnection(userId);
  if (!conn) return NextResponse.json({ connected: false });
  const summary = await backfillSummary(store, userId, new Date());
  return NextResponse.json({ connected: true, status: conn.status, ...summary, done: summary.done && conn.lastSeenAt !== null });
}
