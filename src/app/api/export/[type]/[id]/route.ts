import { fileBase } from "@/lib/export/doc";
import { renderDocx } from "@/lib/export/docx";
import { renderExportHtml } from "@/lib/export/html";
import { me } from "@/server/local/app";
import { exportDoc } from "@/server/local/export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PRINT = `<script>addEventListener("load",function(){setTimeout(function(){print()},200)})</script>`;

/**
 * A note (`/api/export/note/<slug>`), a day (`/api/export/day/2026-11-25`) or today's brief
 * (`/api/export/day/today`) as a file. ?format=html (default) | docx | print (the same HTML,
 * shown in the browser and opening its print dialog, for Save as PDF) | inline (HTML shown, not downloaded).
 */
export async function GET(req: Request, { params }: { params: Promise<{ type: string; id: string }> }) {
  const { type, id } = await params;
  const user = await me();
  if (!user) return new Response("Finish setup first.", { status: 409 });
  const doc = await exportDoc(user, type, decodeURIComponent(id));
  if (!doc) return new Response("Not found", { status: 404 });
  const format = new URL(req.url).searchParams.get("format") ?? "html";
  const base = fileBase(doc.title);
  const common = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  if (format === "docx") {
    const bytes = await renderDocx(doc);
    return new Response(new Uint8Array(bytes), {
      headers: { ...common, "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "Content-Disposition": `attachment; filename="${base}.docx"` },
    });
  }
  if (format === "print") return new Response(renderExportHtml(doc, { head: PRINT }), { headers: { ...common, "Content-Type": "text/html; charset=utf-8" } });
  if (format === "inline") return new Response(renderExportHtml(doc), { headers: { ...common, "Content-Type": "text/html; charset=utf-8" } });
  if (format !== "html") return new Response("Unknown format", { status: 400 });
  return new Response(renderExportHtml(doc), {
    headers: { ...common, "Content-Type": "text/html; charset=utf-8", "Content-Disposition": `attachment; filename="${base}.html"` },
  });
}
