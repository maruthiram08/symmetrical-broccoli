// Settings › AI › Compare on the server. Two steps, so nothing is spent without a yes:
// 1. estimate(): reads the meeting's transcript (from its recorder, the same way a read does) and
//    returns each pair's estimated cost with a one-time confirmation id (10 minutes).
// 2. run(confirmId): only that estimated request, run once. Results are shown, never saved as items.
// The transcript stays in memory for those 10 minutes at most, as during a normal read.
import { randomUUID } from "node:crypto";
import { diffCloses, diffItems, estimatePairs, totalEstimate, COMPARE_MAX, COMPARE_MIN, type DiffRow, type PairEstimate } from "@/lib/ai/compare";
import { formatInr, safeCostInr } from "@/lib/ai/common";
import { PROVIDERS, isProviderId, qualifiedModel, splitModel, MODEL_NAME, type ProviderId } from "@/lib/ai/providers";
import { knownPeople } from "@/lib/directory/directory";
import { extractMeeting, type PostProcessReport } from "@/lib/extract/extract";
import { AnthropicCallError } from "@/lib/extract/errors";
import { extractMeetingOllama } from "@/lib/extract/ollama";
import { providerOf, type ExtractionInput, type ExtractionResult, type User } from "@/lib/types";
import { aiPrefs, baseUrlOf, clientFor, ensurePrices, messageFor, noteProblem, priceFor } from "@/server/ai-config";
import { MAX_OPEN_DECISIONS } from "@/server/jobs/process";
import { getStore, wisprAuthContext } from "@/server/local/app";
import { localTranscript } from "@/server/recorders";
import { McpWisprClient } from "@/server/wispr/client";

export interface Pair { provider: ProviderId; model: string }

export function parsePairs(raw: Array<{ provider: unknown; model: unknown }>, hosted = false): Pair[] | string {
  const pairs: Pair[] = [];
  for (const r of raw) {
    const model = String(r.model ?? "").trim();
    if (!isProviderId(r.provider) && !model) continue;
    if (!isProviderId(r.provider) || (hosted && PROVIDERS[r.provider].localOnly)) return "Pick a provider for each pair.";
    if (!model || !MODEL_NAME.test(model)) return "Type a model name for each pair.";
    pairs.push({ provider: r.provider, model });
  }
  const keys = new Set(pairs.map((p) => qualifiedModel(p.provider, p.model)));
  if (keys.size !== pairs.length) return "Pick different models.";
  if (pairs.length < COMPARE_MIN || pairs.length > COMPARE_MAX) return `Pick ${COMPARE_MIN} or ${COMPARE_MAX} models.`;
  return pairs;
}

/** The same input a read of this meeting gets: transcript, open items before it, earlier decisions, known people. */
export async function compareInput(user: User, meetingId: string, deps: { transcript?: (m: NonNullable<Awaited<ReturnType<ReturnType<typeof getStore>["getMeeting"]>>>) => Promise<string> } = {}): Promise<ExtractionInput> {
  const store = getStore();
  const meeting = await store.getMeeting(meetingId);
  if (!meeting || meeting.userId !== user.id) throw new Error("not found");
  let transcript: string;
  if (deps.transcript) transcript = await deps.transcript(meeting);
  else if (providerOf(meeting) === "wispr_flow") {
    const c = new McpWisprClient(wisprAuthContext(user.id));
    try { transcript = await c.getTranscript(meeting.providerMeetingId); } finally { await c.close?.(); }
  } else transcript = await localTranscript(meeting, user);
  const startOf = new Map<string, string>();
  const open: ExtractionInput["openItems"] = [];
  const decisions: Array<{ text: string; createdAt: string }> = [];
  for (const i of await store.listItems(user.id)) {
    if (i.status !== "open" && !(i.status === "done" && i.closedByMeetingId === meeting.id)) continue;
    if (!startOf.has(i.meetingId)) startOf.set(i.meetingId, (await store.getMeeting(i.meetingId))?.startedAt ?? "");
    if (startOf.get(i.meetingId)! >= meeting.startedAt) continue;
    if (i.kind === "decision") decisions.push({ text: i.text, createdAt: i.createdAt });
    else open.push({ id: i.id, kind: i.kind, text: i.text, person: i.person });
  }
  const known = knownPeople(await store.getPeople?.(user.id));
  const openDecisions = decisions.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, MAX_OPEN_DECISIONS).map((d) => ({ text: d.text }));
  return {
    transcript,
    user: { name: user.name, aliases: user.aliases, timeZone: user.timeZone },
    meeting: { title: meeting.title, startedAt: meeting.startedAt, participants: meeting.participants, ...(meeting.shared ? { shared: true, ownerName: meeting.ownerName ?? null } : {}) },
    openItems: open,
    ...(known.length ? { knownPeople: known } : {}),
    ...(openDecisions.length ? { openDecisions } : {}),
  };
}

interface Pending { userId: string; meetingId: string; pairs: Pair[]; input: ExtractionInput; estimates: PairEstimate[]; expires: number }
const g = globalThis as unknown as { __dbCompare?: Map<string, Pending> };
const pending = (): Map<string, Pending> => (g.__dbCompare ??= new Map<string, Pending>());
export const CONFIRM_TTL_MS = 10 * 60_000;

export interface CompareEstimate {
  confirmId: string;
  meetingTitle: string;
  estimates: Array<PairEstimate & { label: string; costLabel: string }>;
  total: { costInr: number; unknown: number; label: string };
  openItems: Array<{ id: string; text: string }>;
}

const costLabel = (e: PairEstimate) => e.note === "free" ? "free (on this computer)" : e.note === "plan" ? "on your plan" : e.costInr === null ? "price unknown" : `≈ ${formatInr(e.costInr)}`;

export async function estimateCompare(user: User, meetingId: string, pairs: Pair[], deps: Parameters<typeof compareInput>[2] = {}, now = Date.now()): Promise<CompareEstimate> {
  ensurePrices();
  const input = await compareInput(user, meetingId, deps);
  const p = aiPrefs();
  const qualified = pairs.map((x) => qualifiedModel(x.provider, x.model));
  const estimates = estimatePairs(input, qualified, (q) => priceFor(q, p));
  for (const [k, v] of pending()) if (v.expires < now) pending().delete(k);
  const confirmId = randomUUID();
  pending().set(confirmId, { userId: user.id, meetingId, pairs, input, estimates, expires: now + CONFIRM_TTL_MS });
  const t = totalEstimate(estimates);
  const meeting = await getStore().getMeeting(meetingId);
  return {
    confirmId,
    meetingTitle: meeting?.title ?? "Meeting",
    estimates: estimates.map((e, i) => ({ ...e, label: `${PROVIDERS[pairs[i].provider].label} · ${pairs[i].model}`, costLabel: costLabel(e) })),
    total: { ...t, label: `≈ ${formatInr(t.costInr) ?? "₹0"}${t.unknown ? ` plus ${t.unknown} unpriced` : ""}` },
    openItems: input.openItems.map((i) => ({ id: i.id, text: i.text })),
  };
}

export interface PairResult {
  label: string;
  qualified: string;
  ok: boolean;
  error?: string;
  newItems: ExtractionResult["newItems"];
  closes: ExtractionResult["closes"];
  usage: ExtractionResult["usage"] | null;
  costInr: number | null;
  costLabel: string;
  ms: number;
  dropped: number;
}

export interface CompareResult { pairs: PairResult[]; rows: DiffRow[]; closes: Array<{ itemId: string; text: string; by: boolean[] }>; totalInr: number }

export type Extractor = (pair: Pair, input: ExtractionInput, report: PostProcessReport) => Promise<ExtractionResult>;

/** Runs one pair once: no retries (someone is waiting, and each try spends credit). */
export const realExtractor: Extractor = async (pair, input, report) => {
  const q = qualifiedModel(pair.provider, pair.model);
  if (pair.provider === "ollama") return extractMeetingOllama(input, { url: baseUrlOf("ollama")!, model: pair.model, report });
  const c = await clientFor(pair.provider);
  if ("error" in c) throw new AnthropicCallError("auth", 401);
  return extractMeeting(input, { client: c.client, model: q, report, retry: { retries: 0 } });
};

/** Runs a confirmed comparison. Unknown, expired or used ids run nothing. */
export async function runCompare(user: User, confirmId: string, extractor: Extractor = realExtractor, now = Date.now()): Promise<CompareResult | string> {
  const job = pending().get(confirmId);
  if (!job || job.userId !== user.id || job.expires < now) return "That estimate expired. Estimate again, then confirm.";
  pending().delete(confirmId); // once only
  ensurePrices();
  const results = await Promise.all(job.pairs.map(async (pair): Promise<PairResult> => {
    const qualified = qualifiedModel(pair.provider, pair.model);
    const label = `${PROVIDERS[pair.provider].label} · ${pair.model}`;
    const report: PostProcessReport = { droppedItems: [], droppedCloses: [] };
    const t0 = Date.now();
    try {
      const r = await extractor(pair, job.input, report);
      const costInr = splitModel(qualified).provider === "ollama" || pair.provider === "claude-plan" ? 0 : safeCostInr(qualified, r.usage);
      await getStore().logEvent({ userId: user.id, type: "compare_run", payload: { model: qualified, ok: true, newItems: r.newItems.length }, tokensIn: r.usage.inputTokens, tokensOut: r.usage.outputTokens, costInr: costInr ?? undefined });
      return {
        label, qualified, ok: true, newItems: r.newItems, closes: r.closes, usage: r.usage, costInr, ms: Date.now() - t0,
        costLabel: pair.provider === "ollama" ? "free" : pair.provider === "claude-plan" ? "on your plan" : costInr === null ? "price unknown" : `${formatInr(costInr)} (estimate from list prices)`,
        dropped: report.droppedItems.length + report.droppedCloses.length,
      };
    } catch (e) {
      const kind = e instanceof AnthropicCallError ? e.kind : null;
      if (kind) noteProblem(pair.provider, kind);
      const error = kind ? messageFor(pair.provider, kind) : e instanceof Error && e.name === "ExtractionError" ? e.message.slice(0, 200) : "Couldn't read the meeting with this model.";
      return { label, qualified, ok: false, error, newItems: [], closes: [], usage: null, costInr: null, costLabel: "—", ms: Date.now() - t0, dropped: 0 };
    }
  }));
  const open = new Map(job.input.openItems.map((o) => [o.id, o.text]));
  return {
    pairs: results,
    rows: diffItems(results.map((r) => (r.ok ? r.newItems : null))),
    closes: diffCloses(results.map((r) => (r.ok ? r.closes : null))).map((c) => ({ ...c, text: open.get(c.itemId) ?? c.itemId })),
    totalInr: results.reduce((a, r) => a + (r.costInr ?? 0), 0),
  };
}
