import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Board } from "@/components/canvas/Board";
import { buildWeek, mondayOf } from "@/lib/canvas/build";
import { addDays, localDate } from "@/lib/brief/time";
import { me } from "@/server/local/app";
import { canvasCtx } from "@/server/canvas/data";
import { CanvasFrame } from "../_shared";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Friday review" };

export default async function WeekPage({ searchParams }: { searchParams: Promise<{ w?: string }> }) {
  const user = await me();
  if (!user) redirect("/setup");
  const q = await searchParams;
  const c = await canvasCtx(user);
  const monday = mondayOf(/^\d{4}-\d{2}-\d{2}$/.test(q.w ?? "") ? q.w! : localDate(c.now, user.timeZone));
  const doc = buildWeek(monday, c);
  return (
    <CanvasFrame board="week" title={doc.title} sub="What was decided, what’s still open and what’s stuck. Drag a card onto Next week to move it there.">
      <p className="cv-weeknav"><Link href={`/canvas/week?w=${addDays(monday, -7)}`}>← Week before</Link><Link href={`/canvas/week?w=${addDays(monday, 7)}`}>Week after →</Link></p>
      <Board doc={doc} />
    </CanvasFrame>
  );
}
