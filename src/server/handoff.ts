// Server side of "Start this": reads the store, drafts once per item per session, logs hand-offs.
// Never fetches or sends a transcript; drafts use the stored item, its quote and meeting title only.
import Anthropic from "@anthropic-ai/sdk";
import { env } from "@/lib/env";
import { costInr } from "@/lib/extract/cost";
import { DraftCache } from "@/lib/handoff/cache";
import { buildContext, samePerson } from "@/lib/handoff/context";
import { draftHandoff, templateDrafts } from "@/lib/handoff/draft";
import { HANDOFF_EVENT, latestHandoffs, startedLabel } from "@/lib/handoff/started";
import type { Drafts, HandoffTarget } from "@/lib/handoff/types";
import type { Meeting } from "@/lib/types";
import { getStore, me } from "@/server/local/app";

const g = globalThis as unknown as { __dbDraftCache?: DraftCache; __dbHandoffClient?: Anthropic };
const cache = () => (g.__dbDraftCache ??= new DraftCache());
const client = () => (g.__dbHandoffClient ??= new Anthropic({ apiKey: env.anthropicKey }));

export type DraftsResponse = { ok: true; drafts: Drafts } | { ok: false; error: string };

export async function draftsFor(itemId: string): Promise<DraftsResponse> {
  const user = await me();
  if (!user) return { ok: false, error: "Finish setup first." };
  const store = getStore();
  const all = await store.listItems(user.id);
  const item = all.find((i) => i.id === itemId);
  if (!item || item.kind === "decision") return { ok: false, error: "That item is gone." };

  const meetings = new Map<string, Pick<Meeting, "title" | "startedAt"> | null>();
  for (const i of all) {
    if (i.id !== item.id && !samePerson(i.person, item.person)) continue;
    if (!meetings.has(i.meetingId)) meetings.set(i.meetingId, await store.getMeeting(i.meetingId));
  }
  const ctx = buildContext({ item, user, meetings, allItems: all, now: new Date() });
  if (!ctx) return { ok: false, error: "Decisions don't need starting." };

  const { drafts } = await cache().getOrMake(item.id, async () => {
    if (!process.env.ANTHROPIC_API_KEY) return templateDrafts(ctx);
    const model = env.extractionModel;
    const r = await draftHandoff(ctx, { client: client(), model });
    if (r.usage) {
      let cost: number | undefined;
      try { cost = costInr(model, r.usage); } catch { cost = undefined; }
      await store.logEvent({
        userId: user.id, type: "handoff_draft",
        payload: { itemId: item.id, model, fallback: r.fallback },
        tokensIn: r.usage.inputTokens, tokensOut: r.usage.outputTokens, costInr: cost,
      });
    } else if (r.fallback) {
      await store.logEvent({ userId: user.id, type: "handoff_draft", payload: { itemId: item.id, model, fallback: r.fallback } });
    }
    return r.drafts;
  });
  return { ok: true, drafts };
}

export async function recordHandoff(itemId: string, target: HandoffTarget, how: "copy" | "open"): Promise<string | null> {
  const user = await me();
  if (!user) return null;
  const store = getStore();
  const item = (await store.listItems(user.id)).find((i) => i.id === itemId);
  if (!item) return null;
  await store.logEvent({ userId: user.id, type: HANDOFF_EVENT, payload: { itemId, target, how } });
  return startedLabel({ target, at: new Date().toISOString() }, user.timeZone, new Date());
}

/** "Started in Slack, 10:42 PM" per item id, for the current user. */
export async function startedLabels(): Promise<Map<string, string>> {
  const user = await me();
  const out = new Map<string, string>();
  if (!user) return out;
  const now = new Date();
  for (const [id, e] of latestHandoffs(await getStore().listEvents(HANDOFF_EVENT), user.id)) out.set(id, startedLabel(e, user.timeZone, now));
  return out;
}
