// Server glue for Ask, nudges and the contradiction catch on the local app.
import Anthropic from "@anthropic-ai/sdk";
import { env } from "@/lib/env";
import { REQUEST_TIMEOUT_MS } from "@/lib/extract/extract";
import { estimateCost, type AskInput, type AskTurnContext } from "@/lib/ask/ask";
import { MAX_QUESTION_CHARS, type Source } from "@/lib/ask/retrieve";
import type { ProviderId } from "@/lib/ai/providers";
import { AnthropicCallError } from "@/lib/extract/errors";
import type { AnthropicLike } from "@/lib/extract/extract";
import { clientForTask, ensurePrices, noteProblem, resolveTask } from "@/server/ai-config";
import { retrieveLocal } from "@/server/ask-index";
import type { Item, Meeting, User } from "@/lib/types";
import { getAiStore, type Contradiction } from "@/server/local/ai-store";
import { runAiJobs, type AiDeps } from "@/server/local/ai-jobs";
import { getStore } from "@/server/local/app";
import { currentAi } from "@/server/ai-state";

const g = globalThis as unknown as { __dbAiClient?: Anthropic };

/** The Anthropic client, or null when no key is set (never throws). */
export function aiClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  // Retries are ours (withAnthropicRetry in the background jobs; none for Ask, someone is waiting).
  return (g.__dbAiClient ??= new Anthropic({ apiKey: env.anthropicKey, maxRetries: 0, timeout: REQUEST_TIMEOUT_MS }));
}

export function aiDeps(): AiDeps {
  return { store: getStore(), ai: getAiStore(), client: aiClient(), model: env.extractionModel, now: () => new Date() };
}

/**
 * Like aiDeps, with the provider picked for Nudges in Settings › AI (nudges and the changed-decision
 * check). Anthropic stays exactly as before. Another provider's key or credit problem is noted for
 * Settings › AI instead of the app banner, and the nudge falls back to the template.
 */
export async function aiDepsForJobs(): Promise<AiDeps> {
  const base = aiDeps();
  const t = resolveTask("nudges");
  if (t.provider === "anthropic") return t.model === base.model ? base : { ...base, model: t.model };
  const r = await clientForTask("nudges");
  if (!r.ok) return { ...base, client: null, model: t.qualified };
  return { ...base, client: quiet(r.client, t.provider), model: t.qualified };
}

/** Turns auth/credit failures into bad_request (after noting them), so jobs don't raise the Anthropic banner. */
function quiet(client: AnthropicLike, provider: ProviderId): AnthropicLike {
  return {
    messages: {
      async create(body, options) {
        try {
          return await client.messages.create(body, options);
        } catch (e) {
          if (e instanceof AnthropicCallError && (e.kind === "auth" || e.kind === "credit")) {
            noteProblem(provider, e.kind);
            throw new AnthropicCallError("bad_request", e.status);
          }
          throw e;
        }
      },
    },
  };
}

/** Called by the scheduler after its jobs. Never throws. */
export async function afterJobs(opts: { nudges?: boolean } = {}): Promise<void> {
  try { await runAiJobs(await aiDepsForJobs(), opts); } catch (e) { console.error("[ai]", e instanceof Error ? e.name : "Error"); }
}

// ---------- Ask ----------

export interface PreparedAsk {
  input: AskInput;
  sources: Source[];
  model: string;
  provider: ProviderId;
  providerLabel: string;
  estimate: { inputTokens: number; costInr: number | null };
  /** How local search found the passages. */
  how: string;
}

/**
 * Sources for a question, found on this computer (src/server/ask-index.ts), plus the thread's earlier
 * turns as history when it is a follow-up. Only these go to the model picked for Ask.
 */
export async function prepareAsk(user: User, question: string, now = new Date(), opts: { history?: AskTurnContext[]; quote?: string | null } = {}): Promise<PreparedAsk> {
  ensurePrices();
  const q = question.slice(0, MAX_QUESTION_CHARS).trim();
  const last = opts.history?.at(-1)?.question;
  const r = await retrieveLocal(user, q, { extra: [opts.quote ?? "", last ?? ""].join(" ").trim(), now });
  const sent = opts.quote ? `About this quote: "${opts.quote}"\n${q}` : q;
  const input: AskInput = { question: sent, sources: r.sources, userName: user.name, timeZone: user.timeZone, now, ...(opts.history?.length ? { history: opts.history } : {}) };
  const t = resolveTask("ask");
  return { input, sources: r.sources, model: t.qualified, provider: t.provider, providerLabel: t.label, estimate: estimateCost(input, t.qualified), how: r.how };
}

// ---------- contradictions ----------

export interface ContradictionView {
  id: string;
  note: string;
  newItem: Item;
  oldItem: Item;
  oldMeeting: Meeting | null;
  newMeeting: Meeting | null;
}

/** Open flags whose two decisions are both still there (and the old one not already closed). */
export async function openContradictions(user: User): Promise<ContradictionView[]> {
  const flags = (await currentAi()).ai.contradictions().filter((c) => c.status === "open");
  if (!flags.length) return [];
  const store = getStore();
  const items = new Map((await store.listItems(user.id)).map((i) => [i.id, i]));
  const out: ContradictionView[] = [];
  for (const c of flags) {
    const n = items.get(c.newId), o = items.get(c.oldId);
    if (!n || !o || n.status === "wrong" || o.status !== "open") continue;
    out.push({ id: c.id, note: c.note, newItem: n, oldItem: o, oldMeeting: await store.getMeeting(o.meetingId), newMeeting: await store.getMeeting(n.meetingId) });
  }
  return out;
}

export async function resolveContradiction(user: User, id: string, how: "keep" | "replace"): Promise<Contradiction | null> {
  const { ai, save } = await currentAi();
  const c = ai.contradictions().find((x) => x.id === id);
  if (!c) return null;
  if (how === "replace") {
    const store = getStore();
    const old = (await store.listItems(user.id)).find((i) => i.id === c.oldId);
    if (old) await store.setItemStatus(old.id, "done", new Date().toISOString());
    await store.logEvent({ userId: user.id, type: "decision_replaced", payload: { oldId: c.oldId, newId: c.newId } });
  }
  const out = ai.setContradictionStatus(id, how === "keep" ? "kept" : "replaced");
  await save();
  return out;
}
