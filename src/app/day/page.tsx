import type { Metadata } from "next";
import { DailyBriefs, viewOf } from "./_briefs";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Daily briefs" };

// Every evening's brief, newest first; the latest one is open on the right.
export default async function Days({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  return <DailyBriefs date={null} view={viewOf((await searchParams).view)} picked={false} />;
}
