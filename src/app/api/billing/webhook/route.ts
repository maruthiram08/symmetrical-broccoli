import { NextResponse } from "next/server";
import { isHosted } from "@/server/mode";
import { handleWebhook } from "@/server/hosted/billing";
import { hostedConfig } from "@/server/hosted/config";
import { getDb } from "@/server/hosted/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Razorpay webhook (test mode). The raw body is verified against X-Razorpay-Signature before
// anything is read from it; each event id is applied once.
export async function POST(req: Request) {
  if (!isHosted()) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const raw = await req.text();
  const result = await handleWebhook(
    getDb(), raw,
    { signature: req.headers.get("x-razorpay-signature"), eventId: req.headers.get("x-razorpay-event-id") },
    hostedConfig().billing, new Date(),
  );
  if (result === "bad_signature") return NextResponse.json({ error: "bad_signature" }, { status: 400 });
  return NextResponse.json({ result });
}
