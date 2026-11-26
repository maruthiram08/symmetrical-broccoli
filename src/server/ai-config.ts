// Settings › AI on the server: which provider and model each job uses, the providers' keys (in the
// Keychain or the OS secret store through the vault, like integration tokens; the Anthropic key stays
// where it always was), and an Anthropic-shaped client for any of them.
//
// Nothing changes until you pick something: every job uses the Anthropic API with the extraction
// model setting, and extraction follows the older "Reading model" choice (Claude or Ollama).
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import { Mistral } from "@mistralai/mistralai";
import { OpenRouter } from "@openrouter/sdk";
import Groq from "groq-sdk";
import OpenAI from "openai";
import { join } from "node:path";
import { adapt, geminiBackend, mistralBackend, ollamaBackend, openAiBackend, openRouterBackend, type AiClient, type GeminiLike, type MistralLike, type OpenAiLike, type OpenRouterLike } from "@/lib/ai/adapters";
import { claudePlanClient, checkClaudePlan } from "@/lib/claude-plan/client";
import { failureMessage } from "@/lib/ai/errors";
import { AI_TASKS, PROVIDERS, isProviderId, qualifiedModel, splitModel, type AiTask, type ProviderId, type StructuredMode } from "@/lib/ai/providers";
import { classifyProviderError } from "@/lib/ai/errors";
import { PRICES_USD_PER_MTOK, setExtraPrices } from "@/lib/extract/cost";
import type { AnthropicFailure } from "@/lib/extract/errors";
import { REQUEST_TIMEOUT_MS } from "@/lib/extract/extract";
import { env } from "@/lib/env";
import { isHosted } from "@/server/mode";
import { getVault, lastFour, type Vault } from "@/server/integrations/vault";
import type { AiSecret } from "@/server/local/keychain";
import { readJson, writeJson } from "@/server/local/json-file";
import { extractionPrefs, prefsPath } from "@/server/local/prefs";
import { homeDataDir } from "@/server/local/workspaces";

export interface TaskChoice { provider: ProviderId; model: string }
export interface ProviderPrefs {
  baseUrl?: string;
  structured?: StructuredMode;
  /** The provider's own model list, from the last Test. */
  models?: string[];
  modelsAt?: string;
  /** OpenRouter's prices from its model list, USD per million tokens. */
  pricing?: Record<string, { input: number; output: number }>;
  /** The last Test's answer, for Settings. */
  lastTest?: { ok: boolean; message: string; at: string };
}
export interface SearchPrefs {
  /** "Search on this Mac only": retrieval never calls an API. On by default. */
  localOnly: boolean;
  /** Embeddings next to BM25: off, a local Ollama model, or (local-only off) an OpenAI-compatible provider. */
  embeddings: "off" | "ollama" | "provider";
  embedModel: string;
  embedProvider: "openai" | "compatible";
}
export interface AiPrefs {
  tasks: Partial<Record<AiTask, TaskChoice>>;
  providers: Partial<Record<ProviderId, ProviderPrefs>>;
  /** Prices you entered for estimates, by qualified model name, USD per million tokens. */
  prices: Record<string, { input: number; output: number }>;
  search: SearchPrefs;
  /** The last key or credit problem per provider (other than Anthropic, which uses the app banner). */
  problems: Partial<Record<ProviderId, { kind: "auth" | "credit"; at: string }>>;
}

export const SEARCH_DEFAULTS: SearchPrefs = { localOnly: true, embeddings: "off", embedModel: "", embedProvider: "openai" };

export function aiPrefs(path = prefsPath()): AiPrefs {
  const raw = readJson<{ ai?: Partial<AiPrefs> }>(path, {}).ai ?? {};
  const tasks: AiPrefs["tasks"] = {};
  for (const t of AI_TASKS) {
    const c = raw.tasks?.[t];
    if (c && isProviderId(c.provider) && typeof c.model === "string") tasks[t] = { provider: c.provider, model: c.model };
  }
  return {
    tasks,
    providers: raw.providers && typeof raw.providers === "object" ? raw.providers : {},
    prices: raw.prices && typeof raw.prices === "object" ? raw.prices : {},
    search: { ...SEARCH_DEFAULTS, ...(raw.search ?? {}) },
    problems: raw.problems && typeof raw.problems === "object" ? raw.problems : {},
  };
}

export function saveAiPrefs(change: (p: AiPrefs) => void, path = prefsPath()): AiPrefs {
  const all = readJson<Record<string, unknown>>(path, {});
  const p = aiPrefs(path);
  change(p);
  writeJson(path, { ...all, ai: p });
  installPrices(p);
  return p;
}

// ---------- which model a job uses ----------

export interface ResolvedTask {
  task: AiTask;
  provider: ProviderId;
  /** What the API is sent. */
  model: string;
  /** For logs and prices: the model itself for Anthropic, else "<provider>:<model>". */
  qualified: string;
  label: string;
}

/** The provider and model for a job. Claude plan is refused in hosted mode (falls back to the default). */
export function resolveTask(task: AiTask, p: AiPrefs = aiPrefs(), hosted = isHosted()): ResolvedTask {
  let c = p.tasks[task];
  if (!c && task === "extraction") {
    const old = extractionPrefs();
    if (old.provider === "ollama") c = { provider: "ollama", model: old.ollamaModel };
  }
  if (!c || (hosted && PROVIDERS[c.provider].localOnly)) c = { provider: "anthropic", model: "" };
  const model = c.model.trim() || (c.provider === "anthropic" ? env.extractionModel : c.provider === "ollama" ? extractionPrefs().ollamaModel : c.provider === "claude-plan" ? "sonnet" : "");
  return { task, provider: c.provider, model, qualified: qualifiedModel(c.provider, model), label: PROVIDERS[c.provider].label };
}

export function baseUrlOf(provider: ProviderId, p: AiPrefs = aiPrefs()): string | null {
  if (provider === "ollama") return p.providers.ollama?.baseUrl || extractionPrefs().ollamaUrl;
  return p.providers[provider]?.baseUrl || PROVIDERS[provider].baseUrl;
}

export function structuredOf(provider: ProviderId, p: AiPrefs = aiPrefs()): StructuredMode {
  if (provider === "gemini" || provider === "ollama") return "json_schema";
  return p.providers[provider]?.structured ?? PROVIDERS[provider].structured;
}

// ---------- keys ----------

export async function readKey(provider: ProviderId, vault: Vault = getVault()): Promise<string | null> {
  if (provider === "anthropic") return process.env.ANTHROPIC_API_KEY || null;
  const k = PROVIDERS[provider].key;
  return k ? vault.get(k as AiSecret) : null;
}

/** "••••3f9a" for each provider with a key, so Settings never sees one. */
export async function keyHints(vault: Vault = getVault()): Promise<Partial<Record<ProviderId, string | null>>> {
  const out: Partial<Record<ProviderId, string | null>> = {};
  for (const id of Object.keys(PROVIDERS) as ProviderId[]) if (PROVIDERS[id].key) out[id] = lastFour(await readKey(id, vault));
  return out;
}

export async function saveKey(provider: ProviderId, value: string, vault: Vault = getVault()): Promise<boolean> {
  const k = PROVIDERS[provider].key;
  if (!k || provider === "anthropic") return false;
  const ok = await vault.set(k as AiSecret, value.trim());
  if (ok) clearProblem(provider);
  return ok;
}

export async function removeKey(provider: ProviderId, vault: Vault = getVault()): Promise<void> {
  const k = PROVIDERS[provider].key;
  if (k && provider !== "anthropic") await vault.remove(k as AiSecret);
}

// ---------- clients ----------

/** Builds the SDK client for a provider. Tests replace it with fakes (setSdkFactory). */
export type SdkFactory = (provider: ProviderId, opts: { apiKey: string | null; baseUrl: string | null }) => unknown;

export const realSdk: SdkFactory = (provider, { apiKey, baseUrl }) => {
  const timeout = REQUEST_TIMEOUT_MS;
  switch (PROVIDERS[provider].sdk) {
    case "anthropic": return new Anthropic({ apiKey: apiKey ?? "", maxRetries: 0, timeout });
    case "openai": return new OpenAI({ apiKey: apiKey || "none", baseURL: baseUrl ?? undefined, maxRetries: 0, timeout });
    case "groq": return new Groq({ apiKey: apiKey ?? "", baseURL: baseUrl ?? undefined, maxRetries: 0, timeout });
    case "gemini": return new GoogleGenAI({ apiKey: apiKey ?? "", httpOptions: { timeout, retryOptions: { attempts: 1 }, ...(baseUrl ? { baseUrl } : {}) } });
    case "mistral": return new Mistral({ apiKey: apiKey ?? "", timeoutMs: timeout, retryConfig: { strategy: "none" }, ...(baseUrl ? { serverURL: baseUrl } : {}) });
    case "openrouter": return new OpenRouter({ apiKey: apiKey ?? "", timeoutMs: timeout, retryConfig: { strategy: "none" }, ...(baseUrl ? { serverURL: baseUrl } : {}) });
    default: return null;
  }
};

const g = globalThis as unknown as { __dbSdk?: SdkFactory; __dbPlan?: () => AiClient };
export function setSdkFactory(f: SdkFactory | undefined): void { g.__dbSdk = f; }
/** Tests: a fake Claude plan client, so the real CLI is never started. */
export function setClaudePlanClient(f: (() => AiClient) | undefined): void { g.__dbPlan = f; }
const sdk = () => g.__dbSdk ?? realSdk;

export type ClientResult = { ok: true; client: AiClient; resolved: ResolvedTask } | { ok: false; error: string; resolved: ResolvedTask };

/** An Anthropic-shaped client for a provider, or why there is none (no key, hosted-only refusal). */
export async function clientFor(provider: ProviderId, p: AiPrefs = aiPrefs(), vault: Vault = getVault()): Promise<{ client: AiClient } | { error: string }> {
  const info = PROVIDERS[provider];
  if (info.localOnly && isHosted()) return { error: `${info.label} is only available in the Mac app.` };
  const apiKey = await readKey(provider, vault);
  if (info.key && !apiKey && !info.keyOptional) {
    return { error: provider === "anthropic" ? "Add ANTHROPIC_API_KEY to use this." : `Add your ${info.label} key in Settings › AI.` };
  }
  const baseUrl = baseUrlOf(provider, p);
  if (info.needsBaseUrl && !baseUrl) return { error: `Add the base URL for ${info.label} in Settings › AI.` };
  const mode = structuredOf(provider, p);
  switch (info.sdk) {
    case "anthropic": return { client: sdk()(provider, { apiKey, baseUrl }) as AiClient };
    case "claude-plan": return { client: g.__dbPlan ? g.__dbPlan() : (claudePlanClient() as unknown as AiClient) };
    case "ollama": return { client: adapt(provider, ollamaBackend(baseUrl ?? "http://127.0.0.1:11434"), mode) };
    case "gemini": return { client: adapt(provider, geminiBackend(sdk()(provider, { apiKey, baseUrl }) as GeminiLike), mode) };
    case "mistral": return { client: adapt(provider, mistralBackend(sdk()(provider, { apiKey, baseUrl }) as MistralLike), mode) };
    case "openrouter": return { client: adapt(provider, openRouterBackend(sdk()(provider, { apiKey, baseUrl }) as OpenRouterLike), mode) };
    default: return {
      client: adapt(provider, openAiBackend(sdk()(provider, { apiKey, baseUrl }) as OpenAiLike, provider === "openai" ? { maxTokensField: "max_completion_tokens", streamUsage: true } : {}), mode),
    };
  }
}

/** The client and model for a job, or a message saying what to set up. */
export async function clientForTask(task: AiTask, p: AiPrefs = aiPrefs(), vault: Vault = getVault()): Promise<ClientResult> {
  const resolved = resolveTask(task, p);
  if (!resolved.model) return { ok: false, error: `Pick a model for ${resolved.label} in Settings › AI.`, resolved };
  const r = await clientFor(resolved.provider, p, vault);
  return "error" in r ? { ok: false, error: r.error, resolved } : { ok: true, client: r.client, resolved };
}

// ---------- problems and messages ----------

/** What to show someone waiting, worded for the provider. Anthropic keeps its old words. */
export function messageFor(provider: ProviderId, failure: AnthropicFailure, retry = "try again"): string {
  if (provider === "claude-plan" && failure === "auth") return "Claude Code isn't signed in on this Mac. Open Terminal, run claude, and sign in with your Claude plan.";
  if (provider === "claude-plan" && failure === "transient") return "Your Claude plan is busy or at its usage limit. Try again later.";
  if (provider === "ollama" && (failure === "offline" || failure === "transient")) return "Couldn't reach Ollama. Is it running? (ollama serve)";
  if (provider === "anthropic") return failureMessage(failure, undefined, retry);
  const label = PROVIDERS[provider].label;
  return failureMessage(failure, { account: label, model: label }, retry);
}

/** Records a key or credit problem for a non-Anthropic provider (Anthropic's goes to the app banner). */
export function noteProblem(provider: ProviderId, failure: AnthropicFailure | undefined, now = new Date()): void {
  if (provider === "anthropic") return;
  if (failure !== "auth" && failure !== "credit") return;
  saveAiPrefs((p) => { p.problems[provider] = { kind: failure, at: now.toISOString() }; });
}

export function clearProblem(provider: ProviderId): void {
  if (provider === "anthropic") return;
  const p = aiPrefs();
  if (p.problems[provider]) saveAiPrefs((x) => { delete x.problems[provider]; });
}

// ---------- prices ----------

/** USD per million tokens for a qualified model, or null when unknown. Estimates only. */
export function priceFor(qualified: string, p: AiPrefs = aiPrefs()): { input: number; output: number; source: "anthropic" | "yours" | "openrouter" | "free" | "plan" } | null {
  if (PRICES_USD_PER_MTOK[qualified]) return { ...PRICES_USD_PER_MTOK[qualified], source: "anthropic" };
  if (p.prices[qualified]) return { ...p.prices[qualified], source: "yours" };
  const { provider, model } = splitModel(qualified);
  if (provider === "ollama") return { input: 0, output: 0, source: "free" };
  if (provider === "claude-plan") return { input: 0, output: 0, source: "plan" };
  const or = provider === "openrouter" ? p.providers.openrouter?.pricing?.[model] : undefined;
  return or ? { ...or, source: "openrouter" } : null;
}

/** Lets cost.ts price every provider's model from these settings. */
export function installPrices(p: AiPrefs = aiPrefs()): void {
  setExtraPrices((m) => {
    const x = priceFor(m, p);
    return x ? { input: x.input, output: x.output } : null;
  });
}

const gp = globalThis as unknown as { __dbPricesAt?: number };
/** Refresh the price lookup from prefs at most every few seconds. */
export function ensurePrices(): void {
  const now = Date.now();
  if (gp.__dbPricesAt && now - gp.__dbPricesAt < 5000) return;
  gp.__dbPricesAt = now;
  try { installPrices(); } catch { /* prefs unreadable: Anthropic prices only */ }
}

// ---------- Test: list models (free), or one tiny Claude Code call ----------

export interface TestResult { ok: boolean; message: string; models?: string[]; failure?: AnthropicFailure }

const ids = (xs: unknown[]): string[] =>
  xs.map((x) => (typeof x === "string" ? x : x && typeof x === "object" ? String((x as { id?: unknown; name?: unknown }).id ?? (x as { name?: unknown }).name ?? "") : "")).filter(Boolean);

/** Finds the first array of {id} objects inside an SDK answer (pages differ between SDKs). */
function findList(v: unknown, depth = 0): unknown[] {
  if (Array.isArray(v)) return v;
  if (!v || typeof v !== "object" || depth > 3) return [];
  for (const k of ["data", "models", "result", "items"]) {
    const r = findList((v as Record<string, unknown>)[k], depth + 1);
    if (r.length) return r;
  }
  return [];
}

async function collect(v: unknown): Promise<unknown[]> {
  if (v && typeof (v as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
    const out: unknown[] = [];
    for await (const x of v as AsyncIterable<unknown>) {
      const inner = findList(x);
      if (inner.length) out.push(...inner); else out.push(x);
      if (out.length > 2000) break;
    }
    return out;
  }
  return findList(v);
}

const perMtok = (perToken: unknown) => {
  const n = Number(perToken);
  return Number.isFinite(n) && n >= 0 ? n * 1_000_000 : null;
};

/**
 * Settings' Test: checks the key and lists the models the provider offers (a free call), keeping
 * the list as suggestions and OpenRouter's prices. Claude plan runs one tiny request. Never throws.
 */
export async function testProvider(provider: ProviderId, vault: Vault = getVault()): Promise<TestResult> {
  const p = aiPrefs();
  const info = PROVIDERS[provider];
  if (provider === "claude-plan") {
    if (isHosted()) return { ok: false, message: `${info.label} is only available in the Mac app.` };
    return g.__dbPlan ? { ok: true, message: "Claude Code is signed in and answering." } : checkClaudePlan();
  }
  if (provider === "ollama") {
    const url = baseUrlOf("ollama", p)!;
    try {
      const res = await fetch(`${url.replace(/\/+$/, "")}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return { ok: false, message: `Ollama answered HTTP ${res.status}.` };
      const models = ids(((await res.json()) as { models?: Array<{ name?: string }> }).models ?? []);
      saveAiPrefs((x) => { x.providers.ollama = { ...x.providers.ollama, models, modelsAt: new Date().toISOString() }; });
      return { ok: true, message: `Ollama is running with ${models.length} model${models.length === 1 ? "" : "s"}.`, models };
    } catch {
      return { ok: false, message: `Couldn't reach Ollama at ${url}. Is it running? (ollama serve)`, failure: "offline" };
    }
  }
  const apiKey = await readKey(provider, vault);
  if (info.key && !apiKey && !info.keyOptional) return { ok: false, message: provider === "anthropic" ? "No ANTHROPIC_API_KEY is set." : `Add your ${info.label} key first.` };
  const baseUrl = baseUrlOf(provider, p);
  if (info.needsBaseUrl && !baseUrl) return { ok: false, message: "Add the base URL first." };
  try {
    const client = sdk()(provider, { apiKey, baseUrl }) as { models: { list(): unknown } };
    const raw = await collect(await client.models.list());
    const models = ids(raw).map((m) => m.replace(/^models\//, "")).slice(0, 500);
    const pricing: Record<string, { input: number; output: number }> = {};
    if (provider === "openrouter") {
      for (const m of raw as Array<{ id?: string; pricing?: { prompt?: unknown; completion?: unknown } }>) {
        const i = perMtok(m?.pricing?.prompt), o = perMtok(m?.pricing?.completion);
        if (m?.id && i !== null && o !== null) pricing[m.id] = { input: i, output: o };
      }
    }
    saveAiPrefs((x) => {
      x.providers[provider] = { ...x.providers[provider], models, modelsAt: new Date().toISOString(), ...(provider === "openrouter" ? { pricing } : {}) };
      delete x.problems[provider];
    });
    return { ok: true, message: `The key works. ${models.length} model${models.length === 1 ? "" : "s"} available.`, models };
  } catch (e) {
    const failure = classifyProviderError(e);
    noteProblem(provider, failure);
    return { ok: false, message: messageFor(provider, failure), failure };
  }
}

/** Where keys live, for the Settings hint. */
export function keyStoreLabel(vault: Vault = getVault()): string {
  return vault.where === "keychain" ? "the Keychain" : `${join(homeDataDir(), "secrets.json")} (readable only by you)`;
}
