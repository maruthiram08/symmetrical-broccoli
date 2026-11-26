import { NextResponse } from "next/server";
import { trayTitle, widgetSummary } from "@/lib/platform/widget";
import { getStore, me } from "@/server/local/app";
import { widgetAllowed } from "@/server/local/widget-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!widgetAllowed(req.headers)) {
    return NextResponse.json({ error: "Add your widget token as: Authorization: Bearer <token>" }, { status: 401, headers: { "cache-control": "no-store" } });
  }
  const user = await me();
  if (!user) return NextResponse.json({ text: "Set up Daily brief first", owe: 0, overdue: 0, waiting: 0, next: null, title: "" }, { headers: { "cache-control": "no-store" } });
  const s = await widgetSummary(getStore(), user, new Date());
  return NextResponse.json({ ...s, title: trayTitle(s) }, { headers: { "cache-control": "no-store" } });
}
