import { renderReviewHtml, reviewFileName } from "@/lib/review/html";
import { me } from "@/server/local/app";
import { loadReview } from "@/server/local/review";

export const dynamic = "force-dynamic";

/** The review as one static HTML file to download and share. Quotes only with ?quotes=1. */
export async function GET(req: Request, { params }: { params: Promise<{ kind: string; key: string }> }) {
  const { kind, key } = await params;
  if (kind !== "month" && kind !== "year") return new Response("Not found", { status: 404 });
  const user = await me();
  if (!user) return new Response("Finish setup first.", { status: 409 });
  const now = new Date();
  const r = await loadReview(user, kind, key, now);
  if (!r) return new Response("Not found", { status: 404 });
  const quotes = new URL(req.url).searchParams.get("quotes") === "1";
  return new Response(renderReviewHtml(r, { quotes, timeZone: user.timeZone, now }), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Disposition": `attachment; filename="${reviewFileName(r)}"`,
      "Cache-Control": "no-store",
    },
  });
}
