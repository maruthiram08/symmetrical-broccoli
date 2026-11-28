"use server";

// Settings › AI: providers' keys, base URLs and Test; which model each job uses; prices for
// estimates; local search for Ask. Changed only on the computer itself (not from a paired phone).
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AI_TASKS, MODEL_NAME, PROVIDERS, isProviderId, type ProviderId } from "@/lib/ai/providers";
import { aiPrefs, removeKey, saveAiPrefs, saveKey, testProvider, type TaskChoice } from "@/server/ai-config";
import { isRemote } from "@/server/local/phone-proxy";
import { extractionPrefs, saveExtractionPrefs } from "@/server/local/prefs";
import { isHosted } from "@/server/mode";

const back = (anchor = "ai", q = "") => redirect(`/setup${q ? `?${q}` : ""}#${anchor}`);

async function onThisMac(): Promise<void> {
  if (isRemote(await headers())) redirect("/setup?remote=1#ai");
}

/** A provider this mode allows: Claude plan never in hosted mode. */
function providerFrom(v: FormDataEntryValue | null): ProviderId | null {
  const id = String(v ?? "");
  if (!isProviderId(id)) return null;
  if (PROVIDERS[id].localOnly && isHosted()) return null;
  return id;
}

/** http(s) URL with no credentials; kept with its path (OpenAI-compatible servers often end in /v1). */
export async function cleanBaseUrl(u: string): Promise<string | null> {
  try {
    const url = new URL(u.trim());
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export async function saveAiTasksAction(fd: FormData): Promise<void> {
  await onThisMac();
  const next: Partial<Record<(typeof AI_TASKS)[number], TaskChoice>> = {};
  for (const t of AI_TASKS) {
    const provider = providerFrom(fd.get(`${t}.provider`));
    const model = String(fd.get(`${t}.model`) ?? "").trim();
    if (!provider) continue;
    if (model && !MODEL_NAME.test(model)) back("ai-jobs", "ai=badmodel");
    next[t] = { provider, model };
  }
  saveAiPrefs((p) => { p.tasks = next; });
  // Keep the older Reading model choice in step with Extraction.
  const old = extractionPrefs();
  const ex = next.extraction;
  if (ex) {
    const all = aiPrefs();
    const wantOllama = ex.provider === "ollama";
    if (wantOllama !== (old.provider === "ollama")) {
      saveExtractionPrefs({ ...old, provider: wantOllama ? "ollama" : "claude", ...(wantOllama && ex.model ? { ollamaModel: ex.model } : {}) });
      saveAiPrefs((p) => { p.tasks = { ...all.tasks, extraction: ex }; });
    }
  }
  revalidatePath("/", "layout");
  back("ai-jobs", "ai=saved");
}

export async function saveAiProviderAction(fd: FormData): Promise<void> {
  await onThisMac();
  const id = providerFrom(fd.get("provider"));
  if (!id) back();
  const provider = id as ProviderId;
  const info = PROVIDERS[provider];
  const key = String(fd.get("key") ?? "").trim();
  if (key && info.key && provider !== "anthropic") {
    if (!(await saveKey(provider, key))) back(`ai-${provider}`, `ai=badkey&p=${provider}`);
  }
  const rawUrl = fd.get("baseUrl");
  const structured = fd.get("structured");
  let url: string | null | undefined;
  if (rawUrl !== null) {
    url = String(rawUrl).trim() ? await cleanBaseUrl(String(rawUrl)) : null;
    if (String(rawUrl).trim() && !url) back(`ai-${provider}`, `ai=badurl&p=${provider}`);
  }
  saveAiPrefs((p) => {
    const cur = { ...p.providers[provider] };
    if (url !== undefined) { if (url) cur.baseUrl = url; else delete cur.baseUrl; }
    if (structured === "json_schema" || structured === "tool") cur.structured = structured;
    p.providers[provider] = cur;
  });
  if (fd.get("test") === "1") await runTest(provider);
  revalidatePath("/setup");
  back(`ai-${provider}`, fd.get("test") === "1" ? `ai=tested&p=${provider}` : `ai=saved&p=${provider}`);
}

async function runTest(provider: ProviderId): Promise<void> {
  const r = await testProvider(provider);
  saveAiPrefs((p) => { p.providers[provider] = { ...p.providers[provider], lastTest: { ok: r.ok, message: r.message, at: new Date().toISOString() } }; });
}

export async function testAiProviderAction(fd: FormData): Promise<void> {
  await onThisMac();
  const provider = providerFrom(fd.get("provider"));
  if (!provider) back();
  await runTest(provider!);
  revalidatePath("/setup");
  back(`ai-${provider}`, `ai=tested&p=${provider}`);
}

export async function removeAiKeyAction(fd: FormData): Promise<void> {
  await onThisMac();
  const provider = providerFrom(fd.get("provider"));
  if (!provider) back();
  await removeKey(provider!);
  saveAiPrefs((p) => { delete p.problems[provider!]; if (p.providers[provider!]) delete p.providers[provider!]!.lastTest; });
  revalidatePath("/setup");
  back(`ai-${provider}`);
}

export async function saveAiPricesAction(fd: FormData): Promise<void> {
  await onThisMac();
  const prices: Record<string, { input: number; output: number }> = {};
  for (const [k, v] of fd.entries()) {
    const m = /^price\.(in|out)\.(.+)$/.exec(k);
    if (!m) continue;
    const model = m[2];
    if (!/^[a-z-]+:[A-Za-z0-9._:/@+-]{1,160}$/.test(model)) continue;
    const n = Number(String(v).trim());
    if (!String(v).trim() || !Number.isFinite(n) || n < 0 || n > 10_000) continue;
    prices[model] = { ...(prices[model] ?? { input: 0, output: 0 }), [m[1] === "in" ? "input" : "output"]: n };
  }
  saveAiPrefs((p) => {
    for (const [k, v] of Object.entries(prices)) p.prices[k] = v;
    for (const k of Object.keys(p.prices)) if (fd.get(`price.clear.${k}`) === "1") delete p.prices[k];
  });
  revalidatePath("/setup");
  back("ai-prices", "ai=saved");
}

export async function saveAskSearchAction(fd: FormData): Promise<void> {
  await onThisMac();
  const localOnly = fd.get("localOnly") === "on";
  const emb = String(fd.get("embeddings") ?? "off");
  const embedModel = String(fd.get("embedModel") ?? "").trim();
  if (embedModel && !MODEL_NAME.test(embedModel)) back("ai-search", "ai=badmodel");
  const embeddings = emb === "ollama" ? "ollama" : emb === "provider" && !localOnly ? "provider" : "off";
  const embedProvider = fd.get("embedProvider") === "compatible" ? "compatible" : "openai";
  saveAiPrefs((p) => { p.search = { localOnly, embeddings, embedModel, embedProvider }; });
  revalidatePath("/setup");
  back("ai-search", "ai=saved");
}
