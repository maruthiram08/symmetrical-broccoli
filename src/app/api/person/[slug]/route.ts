import { NextResponse } from "next/server";
import { personCard } from "@/lib/wow/person-card";
import { me } from "@/server/local/app";
import { loadAll, shortDate } from "../../../_lib/lines";

export const dynamic = "force-dynamic";

/** For the person hover card: what you owe them, what they owe you, and the last meeting together. */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const user = await me();
  if (!user) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const { items, meetings } = await loadAll(user);
  const card = personCard(slug.slice(0, 120), { items, meetings, now: new Date(), self: [user.name, ...user.aliases] });
  if (!card) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(
    { ...card, lastMeeting: card.lastMeeting ? { title: card.lastMeeting.title, date: shortDate(card.lastMeeting.startedAt, user.timeZone) } : null },
    { headers: { "Cache-Control": "no-store" } },
  );
}
