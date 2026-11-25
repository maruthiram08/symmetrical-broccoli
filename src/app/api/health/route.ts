import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The Mac app checks this before reusing a server already on the port. Never includes secrets.
export function GET() {
  return NextResponse.json({ app: "daily-brief", ok: true, pid: process.pid });
}
