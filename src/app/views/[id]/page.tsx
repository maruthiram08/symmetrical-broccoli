import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getStore, me } from "@/server/local/app";
import { ViewsPanes } from "../_views";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const user = await me();
  const id = decodeURIComponent((await params).id);
  const v = user ? (await getStore().listViews(user.id)).find((x) => x.id === id) : undefined;
  return { title: v?.name ?? "View" };
}

export default async function ViewPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await me();
  if (!user) redirect("/setup");
  const id = decodeURIComponent((await params).id);
  if (!(await getStore().listViews(user.id)).some((v) => v.id === id)) notFound();
  return <ViewsPanes id={id} start={null} />;
}
