import type { Metadata } from "next";
import { ReviewHub } from "../../_hub";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Year in review" };

export default async function Page({ params }: { params: Promise<{ y: string }> }) {
  return <ReviewHub kind="year" keyStr={(await params).y} picked />;
}
