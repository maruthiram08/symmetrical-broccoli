import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Board } from "@/components/canvas/Board";
import { buildCombine, buildConflict } from "@/lib/canvas/build";
import { me } from "@/server/local/app";
import { currentAi } from "@/server/ai-state";
import { canvasCtx } from "@/server/canvas/data";
import { CanvasFrame } from "../_shared";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Combine threads" };

export default async function CombinePage({ searchParams }: { searchParams: Promise<{ c?: string; a?: string; b?: string }> }) {
  const user = await me();
  if (!user) redirect("/setup");
  const q = await searchParams;
  const ctx = await canvasCtx(user);
  let doc = null;
  let sub = "";
  if (q.c) {
    const flag = (await currentAi()).ai.contradictions().find((x) => x.id === q.c);
    if (flag) {
      doc = buildConflict(flag, ctx);
      sub = flag.status === "open" ? "Two meetings decided different things. Pick one, and what depended on the other moves with it." : `Settled: ${flag.status === "kept" ? "kept both" : "used the newer one"}.`;
    }
  } else if (q.a && q.b && q.a !== q.b) {
    const a = ctx.meetings.find((m) => m.id === q.a), b = ctx.meetings.find((m) => m.id === q.b);
    if (a && b) { doc = buildCombine(a, b, ctx); sub = "Two meetings side by side. Lines join items that talk about the same thing."; }
  }
  if (!doc) redirect("/canvas");
  return (
    <CanvasFrame user={user} title={doc.title} sub={sub}>
      <Board doc={doc} />
    </CanvasFrame>
  );
}
