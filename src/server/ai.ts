// Server glue for Ask, nudges and the contradiction catch on the local app.
import Anthropic from "@anthropic-ai/sdk";
import { env } from "@/lib/env";
import { estimateCost, type AskInput } from "@/lib/ask/ask";
import { fitSources } from "@/lib/ask/prompt";
import { MAX_QUESTION_CHARS, retrieve, type Source } from "@/lib/ask/retrieve";
import type { Item, Meeting, User } from "@/lib/types";
import { getAiStore, type Contradiction } from "@/server/local/ai-store";
import { runAiJobs, type AiDeps } from "@/server/local/ai-jobs";
import { getStore } from "@/server/local/app";

const g = globalThis as unknown as { __dbAiClient?: Anthropic };

/** The Anthropic client, or null when no key is set (never throws). */
export function aiClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  return (g.__dbAiClient ??= new Anthropic({ apiKey: env.anthropicKey }));
}

export function aiDeps(): AiDeps {
  return { store: getStore(), ai: getAiStore(), client: aiClient(), model: env.extractionModel, now: () => new Date() };
}

/** Called by the scheduler after its jobs. Never throws. */
export async function afterJobs(opts: { nudges?: boolean } = {}): Promise<void> {
  try { await runAiJobs(aiDeps(), opts); } catch (e) { console.error("[ai]", e instanceof Error ? e.name : "Error"); }
}

// ---------- Ask ----------

export interface PreparedAsk {
  input: AskInput;
  sources: Source[];
  model: string;
  estimate: { inputTokens: number; costInr: number | null };
}

export async function prepareAsk(user: User, question: string, now = new Date()): Promise<PreparedAsk> {
  const store = getStore();
  const q = question.slice(0, MAX_QUESTION_CHARS).trim();
  const [items, meetings] = await Promise.all([store.listItems(user.id), store.listMeetingsBetween(user.id, "0000", "9999")]);
  const sources = fitSources(retrieve(q, items, meetings, now), user.timeZone).map((s, k) => ({ ...s, n: k + 1 }));
  const input: AskInput = { question: q, sources, userName: user.name, timeZone: user.timeZone, now };
  const model = env.extractionModel;
  return { input, sources, model, estimate: estimateCost(input, model) };
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
  const flags = getAiStore().contradictions().filter((c) => c.status === "open");
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
  const ai = getAiStore();
  const c = ai.contradictions().find((x) => x.id === id);
  if (!c) return null;
  if (how === "replace") {
    const store = getStore();
    const old = (await store.listItems(user.id)).find((i) => i.id === c.oldId);
    if (old) await store.setItemStatus(old.id, "done", new Date().toISOString());
    await store.logEvent({ userId: user.id, type: "decision_replaced", payload: { oldId: c.oldId, newId: c.newId } });
  }
  return ai.setContradictionStatus(id, how === "keep" ? "kept" : "replaced");
}
