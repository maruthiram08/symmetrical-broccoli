// POST /api/v1/clips: the web clipper (extensions/clipper) saves a page selection or a readable
// article, as Markdown, to the workspace's Inbox note or to a new note. Same token, localhost and
// origin checks as the rest of the local API (route() in api.ts).
import { z } from "zod";
import { readPage, savePage, createPage } from "@/server/local/pages";
import { notesDir } from "@/server/local/paths";
import { route } from "./api";

export const CLIP_MAX_CHARS = 200_000;
export const INBOX_SLUG = "inbox";

const schema = z.object({
  markdown: z.string().min(1).max(CLIP_MAX_CHARS),
  title: z.string().trim().max(200).optional(),
  url: z.string().url().max(2000).optional(),
  target: z.enum(["inbox", "new"]).default("inbox"),
  kind: z.enum(["selection", "article"]).optional(),
}).strict();

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });

/** Only http(s) links go in the note; anything else is dropped. */
function safeUrl(u?: string): URL | null {
  if (!u) return null;
  try { const x = new URL(u); return x.protocol === "http:" || x.protocol === "https:" ? x : null; } catch { return null; }
}

/** A Markdown link label: no brackets or newlines. */
const label = (s: string) => s.replace(/[[\]\n\r]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);

/** The block a clip adds: a heading, where it came from and when, then the Markdown. */
export function clipBlock(c: { markdown: string; title?: string; url?: string; kind?: string }, now: Date, tz = "UTC"): string {
  const u = safeUrl(c.url);
  const title = label(c.title || (u ? u.hostname : "Clip"));
  const day = now.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: tz });
  const from = u ? `[${label(u.hostname.replace(/^www\./, ""))}](${u.toString().replace(/\)/g, "%29")})` : "the web";
  const what = c.kind === "selection" ? "Selection" : "Clipped";
  return `## ${title}\n\n*${what} from ${from} on ${day}*\n\n${c.markdown.trim()}\n`;
}

export function saveClip(c: z.infer<typeof schema>, now: Date, tz: string, dir = notesDir()): { slug: string } {
  const block = clipBlock(c, now, tz);
  if (c.target === "new") {
    const u = safeUrl(c.url);
    return createPage(label(c.title || (u ? u.hostname : "Clip")) || "Clip", dir, block.replace(/^## .*\n\n/, ""));
  }
  const page = readPage(INBOX_SLUG, dir);
  if (!page) {
    savePage(INBOX_SLUG, `# Inbox\n\nClips and quick notes land here.\n\n${block}`, null, dir, now);
  } else {
    savePage(INBOX_SLUG, `${page.markdown.replace(/\s*$/, "")}\n\n---\n\n${block}`, page.hash, dir, now);
  }
  return { slug: INBOX_SLUG };
}

export const createClipRoute = route(async (req, deps, { user }) => {
  const raw = await req.json().catch(() => null);
  const p = schema.safeParse(raw);
  if (!p.success) return reply({ error: p.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") }, 400);
  const { slug } = saveClip(p.data, deps.now(), user.timeZone);
  await deps.afterWrite?.();
  return reply({ ok: true, slug, target: p.data.target, url: `${deps.appUrl.replace(/\/+$/, "")}/notes/${encodeURIComponent(slug)}` }, 201);
});
