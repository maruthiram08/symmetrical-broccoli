import { verifyToken } from "@/lib/links";
import { exportNotes } from "@/lib/actions-apply";
import { zip } from "./zip";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const p = verifyToken(token);
  if (!p || p.a !== "download") return new Response("This link has expired.", { status: 404 });
  const files = await exportNotes(p.u);
  const body = zip(files);
  return new Response(body as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": 'attachment; filename="daily-brief-notes.zip"',
      "Cache-Control": "no-store",
    },
  });
}
