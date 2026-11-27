import { NextResponse } from "next/server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getFileStore, me } from "@/server/local/app";
import { isHosted } from "@/server/mode";
import { captureClip } from "@/server/capture/clip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const body = z.object({ text: z.string().max(100_000), html: z.string().max(400_000).nullable().optional() });

/**
 * "Capture from clipboard" from the Mac app's shortcut: the app reads the clipboard (plain text and
 * HTML) and posts it here. The tray header means a web page in a browser can't call it (it would
 * need a CORS preflight), the same as /api/check-now.
 */
export async function POST(req: Request) {
  if (req.headers.get("x-daily-brief") !== "tray" || isHosted()) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const p = body.safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({ error: "bad clip" }, { status: 400 });
  const user = await me();
  if (!user) return NextResponse.json({ error: "Set up Daily brief first." }, { status: 409 });
  const r = await captureClip(getFileStore(), user, p.data);
  if (!r) return NextResponse.json({ error: "The clipboard is empty." }, { status: 422 });
  revalidatePath("/", "layout");
  return NextResponse.json(r, { status: 201 });
}
