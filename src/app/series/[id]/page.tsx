import type { Metadata } from "next";
import { getStore, me } from "@/server/local/app";
import { Recurring } from "../_series";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const user = await me();
  const cache = user ? await getStore().getCalendar(user.id) : null;
  return { title: cache?.series.find((x) => x.id === id)?.title ?? "Recurring meeting" };
}

// One recurring meeting from your calendar (a standup, a 1:1).
export default async function Series({ params }: { params: Promise<{ id: string }> }) {
  return <Recurring pick={{ id: (await params).id }} />;
}
