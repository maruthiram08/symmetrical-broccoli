import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Board } from "@/components/canvas/Board";
import { buildStart } from "@/lib/canvas/build";
import { me } from "@/server/local/app";
import { canvasCtx, windowsFor } from "@/server/canvas/data";
import { CanvasFrame } from "../../_shared";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Start this" };

export default async function StartPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await me();
  if (!user) redirect("/setup");
  const { id } = await params;
  const c = await canvasCtx(user);
  const item = c.items.find((i) => i.id === decodeURIComponent(id));
  if (!item) notFound();
  const windows = windowsFor(item.id);
  const doc = buildStart(item, windows, c);
  return (
    <CanvasFrame user={user} title={doc.title} sub="Start the work in a new window. It reads everything linked on the left, and finishing it closes the item.">
      <Board doc={doc} windows={windows} />
    </CanvasFrame>
  );
}
