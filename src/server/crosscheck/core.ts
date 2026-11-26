// Cross-check with Wispr Flow, on the server: fetch one meeting's Flow Summary (never the
// transcript), read its action items, compare them with this meeting's items through the model
// picked for Extraction in Settings › AI, and keep the result per meeting in the FileStore.
// Local app only and off by default (Settings › AI › Cross-check with Wispr Flow).
import { safeCostInr } from "@/lib/ai/common";
import type { AnthropicLike } from "@/lib/extract/extract";
import { compareMeeting, type CrossCheckRecord, type CrossEntry, type DroppedText } from "@/lib/crosscheck/compare";
import { parseActionItems } from "@/lib/crosscheck/parse";
import { providerOf, type Item, type Meeting, type User } from "@/lib/types";
import type { WisprClient } from "@/server/wispr/client";
import { ReconnectRequiredError } from "@/server/wispr/oauth";
import { readJson, writeJson } from "@/server/local/json-file";
import { prefsPath } from "@/server/local/prefs";
import { isHosted } from "@/server/mode";

// ---------- the switch (prefs.json, off by default) ----------

export function crosscheckEnabled(path = prefsPath()): boolean {
  return readJson<{ crosscheck?: { enabled?: unknown } }>(path, {}).crosscheck?.enabled === true;
}

export function saveCrosscheckEnabled(on: boolean, path = prefsPath()): void {
  const all = readJson<Record<string, unknown>>(path, {});
  writeJson(path, { ...all, crosscheck: { enabled: on } });
}

// ---------- one meeting ----------

/** The store calls a cross-check needs: the FileStore has them all. */
export interface CrossStore {
  getMeeting(id: string): Promise<Meeting | null>;
  getUser(id: string): Promise<User | null>;
  listItems(userId: string): Promise<Item[]>;
  logEvent(e: { userId: string | null; type: string; payload?: unknown; tokensIn?: number; tokensOut?: number; costInr?: number }): Promise<void>;
  listEvents?(type?: string): Promise<Array<Record<string, unknown>>>;
  getCrossCheck(meetingId: string): Promise<CrossCheckRecord | null>;
  saveCrossCheck(rec: CrossCheckRecord): Promise<void>;
}

export const isCrossStore = (s: unknown): s is CrossStore =>
  !!s && typeof (s as CrossStore).saveCrossCheck === "function" && typeof (s as CrossStore).getCrossCheck === "function";

/** The model for the comparison: the Extraction job's provider and model, or why there is none. */
export type ModelPick = () => Promise<{ client: AnthropicLike; model: string; provider: string } | { error: string }>;

export interface CrossDeps {
  store: CrossStore;
  wispr: (userId: string) => WisprClient;
  model: ModelPick;
  now: () => Date;
}

/** What extraction dropped for this meeting, from its newest extract_run event. */
export async function droppedFor(store: CrossStore, meetingId: string): Promise<DroppedText[]> {
  const events = (await store.listEvents?.("extract_run")) ?? [];
  for (let k = events.length - 1; k >= 0; k--) {
    const p = events[k].payload as { meetingId?: unknown; dropped?: unknown } | undefined;
    if (p?.meetingId !== meetingId) continue;
    return Array.isArray(p.dropped)
      ? p.dropped.filter((d): d is DroppedText => !!d && typeof d.text === "string" && typeof d.reason === "string")
      : [];
  }
  return [];
}

const key = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Keeps Ignore and Add from an earlier run for the same Wispr item. */
function carryOver(prev: CrossCheckRecord | null, entries: CrossEntry[]): CrossEntry[] {
  if (!prev) return entries;
  const old = new Map(prev.entries.map((e) => [key(e.wispr.text), e]));
  return entries.map((e) => {
    const o = old.get(key(e.wispr.text));
    if (!o || e.verdict !== "missed") return e;
    return { ...e, ...(o.ignored ? { ignored: true } : {}), ...(o.addedItemId ? { addedItemId: o.addedItemId } : {}) };
  });
}

export type CrossOutcome = CrossCheckRecord | { skipped: "not_found" | "not_wispr" | "not_read" };

/**
 * Cross-check one meeting and store the result. A model or Wispr Flow failure is stored as an
 * "error" record (and returned); a ReconnectRequiredError is thrown so a batch can stop.
 */
export async function crossCheckMeeting(
  deps: CrossDeps,
  meetingId: string,
  opts: { client?: WisprClient; dropped?: DroppedText[] } = {},
): Promise<CrossOutcome> {
  const { store } = deps;
  const meeting = await store.getMeeting(meetingId);
  if (!meeting) return { skipped: "not_found" };
  if (providerOf(meeting) !== "wispr_flow") return { skipped: "not_wispr" };
  if (!meeting.processedAt) return { skipped: "not_read" };
  const user = await store.getUser(meeting.userId);
  if (!user) return { skipped: "not_found" };
  const prev = await store.getCrossCheck(meeting.id);
  const base = { meetingId: meeting.id, userId: user.id, checkedAt: deps.now().toISOString(), entries: [] as CrossEntry[], model: null as string | null };
  const app = (await store.listItems(user.id)).filter((i) => i.meetingId === meeting.id && (i.kind === "owe" || i.kind === "waiting"));
  const appIds = app.filter((i) => i.status !== "wrong").map((i) => i.id);

  const save = async (rec: CrossCheckRecord) => { await store.saveCrossCheck(rec); return rec; };

  let summary: string | null;
  const client = opts.client ?? deps.wispr(user.id);
  try {
    if (!client.getSummary) return save({ ...base, status: "error", error: "This Wispr Flow connection can't read summaries.", onlyInApp: appIds });
    summary = await client.getSummary(meeting.providerMeetingId);
  } catch (e) {
    if (e instanceof ReconnectRequiredError) throw e;
    return save({ ...base, status: "error", error: "Couldn't fetch the summary from Wispr Flow.", onlyInApp: appIds });
  } finally {
    if (!opts.client) await client.close?.();
  }
  if (!summary) return save({ ...base, status: "no_summary", onlyInApp: appIds });
  const wispr = parseActionItems(summary);
  if (!wispr.length) return save({ ...base, status: "no_actions", onlyInApp: appIds });

  const pick = await deps.model();
  if ("error" in pick) return save({ ...base, status: "error", error: pick.error, onlyInApp: appIds });
  const dropped = opts.dropped ?? (await droppedFor(store, meeting.id));
  const r = await compareMeeting(
    {
      user: { name: user.name, aliases: user.aliases },
      meeting: { title: meeting.title, participants: meeting.participants },
      summary,
      wispr,
      app: app.map((i) => ({ id: i.id, kind: i.kind, text: i.text, person: i.person, status: i.status })),
      dropped,
    },
    { client: pick.client, model: pick.model },
  );
  const rec: CrossCheckRecord = r.error
    ? { ...base, model: pick.model, status: "error", failure: r.failure ?? null, error: r.failure === "auth" || r.failure === "credit" ? "The model for Extraction rejected the key or is out of credit." : "The model couldn't compare this meeting.", onlyInApp: appIds, usage: r.usage }
    : { ...base, model: pick.model, status: "ok", entries: carryOver(prev, r.entries), onlyInApp: r.onlyInApp, usage: r.usage };
  await save(rec);
  const u = r.usage;
  await store.logEvent({
    userId: user.id,
    type: "crosscheck_run",
    payload: { meetingId: meeting.id, model: pick.model, status: rec.status, ...(r.failure ? { failure: r.failure } : {}), counts: countBy(rec.entries) },
    ...(u ? { tokensIn: u.inputTokens, tokensOut: u.outputTokens, costInr: safeCostInr(pick.model, u) ?? 0 } : {}),
  });
  return rec;
}

function countBy(entries: CrossEntry[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of entries) out[e.verdict] = (out[e.verdict] ?? 0) + 1;
  return out;
}

// ---------- after each read ----------

export interface ExtractedEvent {
  store: unknown;
  wispr: (userId: string) => WisprClient;
  meetingId: string;
  client?: WisprClient;
  dropped?: DroppedText[];
  now: () => Date;
}

/** Called by process.ts after a meeting's items are committed. No-op unless switched on. Never throws. */
export async function crosscheckAfterExtraction(ev: ExtractedEvent, model?: ModelPick): Promise<void> {
  if (isHosted() || !isCrossStore(ev.store)) return;
  if (!crosscheckEnabled()) return;
  try {
    await crossCheckMeeting({ store: ev.store, wispr: ev.wispr, model: model ?? (await import("./model")).extractionModel, now: ev.now }, ev.meetingId, { dropped: ev.dropped ?? [], client: ev.client });
  } catch (e) {
    console.error(`[crosscheck] ${e instanceof Error ? e.name : "Error"}`);
  }
}
