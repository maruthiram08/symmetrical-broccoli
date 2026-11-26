import type { Metadata } from "next";
import { Recurring } from "./_series";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Recurring meetings" };

// Every recurring meeting, most open first. ?slot=11:00 picks a series guessed from its time.
export default async function AllSeries({ searchParams }: { searchParams: Promise<{ slot?: string }> }) {
  const { slot } = await searchParams;
  return <Recurring pick={slot && /^\d{2}:\d{2}$/.test(slot) ? { slot } : null} />;
}
