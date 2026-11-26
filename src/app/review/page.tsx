import { redirect } from "next/navigation";
import { currentKeys } from "@/lib/review/review";
import { me } from "@/server/local/app";

export const dynamic = "force-dynamic";

/** /review goes to this month's review. */
export default async function ReviewIndex() {
  const user = await me();
  if (!user) redirect("/setup");
  redirect(`/review/month/${currentKeys(new Date(), user.timeZone).month}`);
}
