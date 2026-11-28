import { NextResponse } from "next/server";
import { checkNow } from "@/server/local/scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Check meetings now" from the Mac app's menu bar. Starts the check and returns at once.
 * The custom header means a web page in a browser can't trigger it (it would need a CORS preflight).
 */
export function POST(req: Request) {
  if (req.headers.get("x-daily-brief") !== "tray") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  void checkNow().catch((e) => console.error("[check-now]", e instanceof Error ? e.name : "Error"));
  return NextResponse.json({ started: true }, { status: 202 });
}
