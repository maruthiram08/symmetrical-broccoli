import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { ReviewView } from "@/components/ReviewView";
import { Shell } from "@/components/Shell";
import { localDate } from "@/lib/brief/time";
import { currentKeys } from "@/lib/review/review";
import { me } from "@/server/local/app";
import { loadReview } from "@/server/local/review";
import { openCountFor, pastDays } from "../../../_lib/days";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Year in review" };

export default async function Page({ params, searchParams }: { params: Promise<{ y: string }>; searchParams: Promise<{ quotes?: string }> }) {
  const user = await me();
  if (!user) redirect("/setup");
  const { y } = await params;
  const quotes = (await searchParams).quotes === "1";
  const now = new Date();
  const r = await loadReview(user, "year", y, now);
  if (!r) notFound();
  return (
    <Shell days={await pastDays(user.id, localDate(now, user.timeZone))} current="review" openCount={await openCountFor(user.id)}>
      <ReviewView r={r} tz={user.timeZone} quotes={quotes} base={`/review/year/${y}`} current={currentKeys(now, user.timeZone)} />
    </Shell>
  );
}
