import { NextResponse } from "next/server";
import { getStore, me } from "@/server/local/app";
import { backfillSummary } from "@/server/jobs/backfill";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Connection state plus backfill totals ({ meetings, promisesMade, stillOpen, done }).
export async function GET() {
  const user = await me();
  if (!user) return NextResponse.json({ connected: false });
  const store = getStore();
  const conn = await store.getConnection(user.id);
  if (!conn) return NextResponse.json({ connected: false });
  const summary = await backfillSummary(store, user.id, new Date());
  return NextResponse.json({ connected: true, status: conn.status, ...summary, done: summary.done && conn.lastSeenAt !== null });
}
