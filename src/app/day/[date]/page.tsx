import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { dateLabel } from "@/lib/brief/time";
import { DailyBriefs, viewOf } from "../_briefs";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ date: string }> }): Promise<Metadata> {
  const { date } = await params;
  return { title: /^\d{4}-\d{2}-\d{2}$/.test(date) ? dateLabel(date) : "Day" };
}

// One day: the brief as it was made, beside your note for that day. The file in your notes folder
// is the source of truth.
export default async function Day({ params, searchParams }: { params: Promise<{ date: string }>; searchParams: Promise<{ view?: string }> }) {
  const { date } = await params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) notFound();
  return <DailyBriefs date={date} view={viewOf((await searchParams).view)} picked />;
}
