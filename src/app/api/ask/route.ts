import { z } from "zod";
import { streamAnswer, type StreamingClient } from "@/lib/ask/ask";
import { MAX_QUESTION_CHARS, isItemSource, type Source } from "@/lib/ask/retrieve";
import { addTurn, contextTurns, newConversation, nameFrom, threadById } from "@/lib/ask/threads";
import { PROVIDERS } from "@/lib/ai/providers";
import { personHref } from "@/app/_lib/links";
import { aiClient, prepareAsk } from "@/server/ai";
import { clientForTask, messageFor, noteProblem, clearProblem } from "@/server/ai-config";
import { changeThreads, newId, readThreads } from "@/server/ask-threads";
import { getStore, me } from "@/server/local/app";

export const dynamic = "force-dynamic";

const Body = z.object({
  q: z.string().trim().min(1).max(MAX_QUESTION_CHARS),
  estimateOnly: z.boolean().optional(),
  /** Ask in this thread (a follow-up). Left out: a new conversation. */
  threadId: z.string().min(1).max(80).optional(),
});

/** Where a cited source goes: an item's person page (else search for its text); a passage's page. */
function hrefOf(s: Source): string {
  if (!isItemSource(s)) return s.href;
  return s.person ? personHref(s.person) : `/search?q=${encodeURIComponent(s.text)}`;
}

/**
 * Ask: NDJSON lines. First {type:"sources", sources, estimate, threadId}, then {type:"text"} chunks
 * as the model writes, then {type:"done", costInr, turnId} or {type:"error"}. With estimateOnly,
 * only the first line. Retrieval runs on this computer; only the top passages and the thread's
 * earlier turns go to the model picked for Ask. The turn is saved to the workspace's conversations.
 */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Ask a question (up to 500 characters)." }, { status: 400 });
  const user = await me();
  if (!user) return Response.json({ error: "Finish setup first." }, { status: 409 });

  const { q, threadId } = parsed.data;
  const state = threadId ? readThreads() : null;
  const thread = threadId && state ? threadById(state, threadId) : null;
  if (threadId && !thread) return Response.json({ error: "That thread is gone. Start a new question." }, { status: 404 });
  const history = thread && state ? contextTurns(state, thread.id).filter((t) => !t.error).map((t) => ({ question: t.question, answer: t.answer })) : [];
  const quote = thread && thread.turns.length === 0 ? thread.quote : null;

  const p = await prepareAsk(user, q, new Date(), { history, quote });
  const sources = p.sources.map((s) => ({ ...s, href: hrefOf(s) }));
  const head = { type: "sources", model: p.model, provider: p.provider, providerLabel: p.providerLabel, how: p.how, estimate: p.estimate, sources };
  if (parsed.data.estimateOnly) return Response.json(head, { headers: { "Cache-Control": "no-store" } });

  const anthropic = p.provider === "anthropic";
  const got = anthropic ? null : await clientForTask("ask");
  const client: StreamingClient | null = anthropic ? aiClient() : got && got.ok ? got.client : null;
  const missing = anthropic ? "Add ANTHROPIC_API_KEY to ask questions." : got && !got.ok ? got.error : "";
  const who = anthropic ? undefined : p.provider === "claude-plan" ? { account: "Claude plan", model: "Claude" } : { account: PROVIDERS[p.provider].label, model: PROVIDERS[p.provider].label };

  // A new question starts a conversation; a follow-up goes in its thread.
  const tid = thread?.id ?? changeThreads((s) => newConversation(s, { id: newId(), name: nameFrom(q), now: new Date().toISOString() }).id);

  const enc = new TextEncoder();
  const line = (o: unknown) => enc.encode(JSON.stringify(o) + "\n");
  const ctl = new AbortController();
  req.signal.addEventListener("abort", () => ctl.abort());
  const save = (answer: string, costInr: number | null, error: string | null) => {
    const turn = { id: newId(), question: q, answer, sources, model: p.model, costInr, at: new Date().toISOString(), error };
    changeThreads((s) => addTurn(s, tid, turn));
    return turn.id;
  };

  const body = new ReadableStream<Uint8Array>({
    async start(c) {
      c.enqueue(line({ ...head, threadId: tid }));
      if (!client && p.sources.length) {
        c.enqueue(line({ type: "error", error: missing, turnId: save("", null, missing) }));
        c.close();
        return;
      }
      let answer = "";
      for await (const ev of streamAnswer(p.input, { client: client!, model: p.model, signal: ctl.signal, who })) {
        if (ev.type === "text") answer += ev.text;
        if (ev.type === "error") {
          const error = !anthropic && ev.failure ? messageFor(p.provider, ev.failure, "ask again") : ev.error;
          c.enqueue(line({ ...ev, error, turnId: save(answer, null, error) }));
          if (ev.failure === "auth" || ev.failure === "credit") {
            // Anthropic: the same banner as when extraction hits it. Others: Settings › AI shows it.
            if (anthropic) await getStore().setHealth({ anthropicProblem: { kind: ev.failure, at: new Date().toISOString() } });
            else noteProblem(p.provider, ev.failure);
          }
          continue;
        }
        if (ev.type === "done") {
          c.enqueue(line({ ...ev, turnId: save(answer, ev.costInr, null) }));
          if (ev.usage) {
            if (anthropic && (await getStore().getHealth()).anthropicProblem) await getStore().setHealth({ anthropicProblem: null });
            if (!anthropic) clearProblem(p.provider);
            await getStore().logEvent({
              userId: user.id, type: "ask",
              payload: { model: p.model, sources: p.sources.length, noAnswer: ev.noAnswer, search: p.how },
              tokensIn: ev.usage.inputTokens, tokensOut: ev.usage.outputTokens, costInr: ev.costInr ?? undefined,
            });
          }
          continue;
        }
        c.enqueue(line(ev));
      }
      c.close();
    },
    cancel() { ctl.abort(); },
  });
  return new Response(body, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
}
