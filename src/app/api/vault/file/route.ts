import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { me } from "@/server/local/app";
import { notesDir } from "@/server/local/paths";
import { absIn, ASSET_RE, isLeftOut, resolveAssetPath } from "@/server/local/vault";

export const dynamic = "force-dynamic";

const TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".svg": "image/svg+xml", ".avif": "image/avif", ".bmp": "image/bmp", ".pdf": "application/pdf",
};
const MAX = 25_000_000;

/** Images (and PDFs) from the notes folder, for ![](picture.png) and ![[picture.png]] in notes. Read only. */
export async function GET(req: Request) {
  if (!(await me())) return new Response("Not set up", { status: 401 });
  const u = new URL(req.url);
  const root = notesDir();
  const name = u.searchParams.get("name");
  const rel = name !== null ? resolveAssetPath(root, name, u.searchParams.get("from") ?? "") : u.searchParams.get("path");
  if (!rel || !ASSET_RE.test(rel) || isLeftOut(root, rel)) return new Response("Not found", { status: 404 });
  try {
    const abs = absIn(root, rel);
    const st = statSync(abs);
    if (!st.isFile() || st.size > MAX) return new Response("Not found", { status: 404 });
    return new Response(new Uint8Array(readFileSync(abs)), {
      headers: {
        "Content-Type": TYPES[extname(rel).toLowerCase()] ?? "application/octet-stream",
        "Cache-Control": "private, max-age=60",
        // An SVG opened on its own must not run scripts on the app's origin.
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
