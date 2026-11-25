import { z } from "zod";
import { streamAnswer } from "@/lib/ask/ask";
import { MAX_QUESTION_CHARS } from "@/lib/ask/retrieve";
import { personHref } from "@/app/_lib/links";
import { aiClient, prepareAsk } from "@/server/ai";
import { getStore, me } from "@/server/local/app";

export const dynamic = "force-dynamic";

const Body = z.object({ q: z.string().trim().min(1).max(MAX_QUESTION_CHARS), estimateOnly: z.boolean().optional() });

/** Where a cited item goes: its person's page, else search for its text. */
function itemHref(s: { person: string | null; text: string }): string {
  return s.person ? personHref(s.person) : `/search?q=${encodeURIComponent(s.text)}`;
}

/**
 * Ask: NDJSON lines. First {type:"sources", sources, estimate}, then {type:"text"} chunks as Claude
 * writes, then {type:"done", costInr} or {type:"error"}. With estimateOnly, only the first line.
 * Sends Claude the question and up to 40 stored items; never a transcript.
 */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Ask a question (up to 500 characters)." }, { status: 400 });
  const user = await me();
  if (!user) return Response.json({ error: "Finish setup first." }, { status: 409 });

  const p = await prepareAsk(user, parsed.data.q);
  const head = {
    type: "sources",
    model: p.model,
    estimate: p.estimate,
    sources: p.sources.map((s) => ({ ...s, href: itemHref(s) })),
  };
  if (parsed.data.estimateOnly) return Response.json(head, { headers: { "Cache-Control": "no-store" } });

  const client = aiClient();
  const enc = new TextEncoder();
  const line = (o: unknown) => enc.encode(JSON.stringify(o) + "\n");
  const ctl = new AbortController();
  req.signal.addEventListener("abort", () => ctl.abort());

  const body = new ReadableStream<Uint8Array>({
    async start(c) {
      c.enqueue(line(head));
      if (!client && p.sources.length) {
        c.enqueue(line({ type: "error", error: "Add ANTHROPIC_API_KEY to ask questions." }));
        c.close();
        return;
      }
      for await (const ev of streamAnswer(p.input, { client: client!, model: p.model, signal: ctl.signal })) {
        c.enqueue(line(ev));
        if (ev.type === "done" && ev.usage) {
          await getStore().logEvent({
            userId: user.id, type: "ask",
            payload: { model: p.model, sources: p.sources.length, noAnswer: ev.noAnswer },
            tokensIn: ev.usage.inputTokens, tokensOut: ev.usage.outputTokens, costInr: ev.costInr ?? undefined,
          });
        }
      }
      c.close();
    },
    cancel() { ctl.abort(); },
  });
  return new Response(body, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
}
