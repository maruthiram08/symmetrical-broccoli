import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Board } from "@/components/canvas/Board";
import { buildMap } from "@/lib/canvas/build";
import { me } from "@/server/local/app";
import { canvasCtx } from "@/server/canvas/data";
import { CanvasFrame } from "../_shared";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Project map" };

export default async function MapPage({ searchParams }: { searchParams: Promise<{ topic?: string }> }) {
  const user = await me();
  if (!user) redirect("/setup");
  const topic = ((await searchParams).topic ?? "").trim().toLowerCase().slice(0, 80);
  if (!topic) redirect("/canvas");
  const doc = buildMap(topic, await canvasCtx(user));
  return (
    <CanvasFrame board="map" title={doc.title} sub="Every meeting about this, oldest on the left. Heavy dashed lines are a later meeting that closed something.">
      {doc.empty ? <p className="cv-empty">{doc.empty}</p> : <Board doc={doc} />}
    </CanvasFrame>
  );
}
