import { NextResponse } from "next/server";
import { isHosted } from "@/server/mode";
import { NotSignedInError, userStore } from "@/server/hosted/app";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// "Download my notes": everything we keep for you, as JSON. Never includes tokens or keys.
export async function GET() {
  if (!isHosted()) return NextResponse.json({ error: "not_found" }, { status: 404 });
  try {
    const store = await userStore();
    const id = store.scope!;
    const body = {
      exportedAt: new Date().toISOString(),
      user: await store.getUser(id),
      meetings: await store.listMeetingsBetween(id, "0000", "9999"),
      items: await store.listItems(id),
      briefs: await store.listBriefs(id),
    };
    return new NextResponse(JSON.stringify(body, null, 2), {
      headers: { "content-type": "application/json", "content-disposition": `attachment; filename="daily-brief-${body.exportedAt.slice(0, 10)}.json"` },
    });
  } catch (e) {
    if (e instanceof NotSignedInError) return NextResponse.json({ error: "sign_in_required" }, { status: 401 });
    throw e;
  }
}
