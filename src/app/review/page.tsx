import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { currentKeys } from "@/lib/review/review";
import { me } from "@/server/local/app";
import { ReviewHub } from "./_hub";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Review" };

/** /review: the hub, with this month's report open. */
export default async function ReviewIndex() {
  const user = await me();
  if (!user) redirect("/setup");
  return <ReviewHub kind="month" keyStr={currentKeys(new Date(), user.timeZone).month} picked={false} />;
}
