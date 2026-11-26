import type { Metadata } from "next";
import { ReviewHub } from "../../_hub";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Monthly review" };

export default async function Page({ params }: { params: Promise<{ ym: string }> }) {
  return <ReviewHub kind="month" keyStr={(await params).ym} picked />;
}
