// Settings › AI on the server, with fake SDKs, a fake vault and a fake Claude plan client.
// No network, no Keychain, and the Claude Code CLI is never started.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Vault } from "@/server/integrations/vault";

process.env.DAILY_BRIEF_DIR = mkdtempSync(join(tmpdir(), "db-aicfg-"));
process.env.EXTRACTION_MODEL = "claude-sonnet-5-5";

const cfg = await import("./ai-config");
const { setVault } = await import("@/server/integrations/vault");
const { extractWithPrefs, extractionCostInr } = await import("@/server/local/extract-local");
const { saveExtractionPrefs, extractionPrefs } = await import("@/server/local/prefs");
const { toolCall } = await import("@/lib/ai/fakes.test-helpers");
const { TOOL_NAME } = await import("@/lib/extract/prompt");
const { safeCostInr } = await import("@/lib/ai/common");

function memVault(): Vault & { data: Record<string, string> } {
  const data: Record<string, string> = {};
  return { data, where: "file", get: async (n) => data[n] ?? null, set: async (n, v) => { data[n] = v; return true; }, remove: async (n) => { delete data[n]; } };
}

const input = {
  transcript: "Maruthi: I'll send Nitin the banner copy by Friday.",
  user: { name: "Maruthi", aliases: [], timeZone: "Asia/Kolkata" },
  meeting: { title: "Banner sync", startedAt: "2026-11-24T06:00:00Z", participants: ["Nitin"] },
  openItems: [],
};
const output = { newItems: [{ kind: "owe", text: "Send Nitin the banner copy", person: "Nitin", quote: "I'll send Nitin the banner copy by Friday", dueAt: null }], closes: [] };

let vault: ReturnType<typeof memVault>;
const sdkCalls: Array<{ provider: string; apiKey: string | null; baseUrl: string | null }> = [];
beforeEach(() => {
  vault = memVault();
  setVault(vault);
  sdkCalls.length = 0;
  cfg.setSdkFactory((provider, opts) => {
    sdkCalls.push({ provider, ...opts });
    return {
      chat: { completions: { create: async () => ({ choices: [{ message: { content: JSON.stringify(output) }, finish_reason: "stop" }], usage: { prompt_tokens: 1000, completion_tokens: 100 } }) } },
      models: { list: async () => (provider === "openrouter"
        ? { data: [{ id: "vendor/a", pricing: { prompt: "0.000001", completion: "0.000002" } }, { id: "vendor/b", pricing: { prompt: "x" } }] }
        : (async function* () { yield { id: "model-one" }; yield { id: "model-two" }; })()) },
    };
  });
  cfg.saveAiPrefs((p) => { p.tasks = {}; p.providers = {}; p.prices = {}; p.problems = {}; p.search = { ...cfg.SEARCH_DEFAULTS }; });
  saveExtractionPrefs({ provider: "claude", ollamaModel: "qwen2.5:14b", ollamaUrl: "http://127.0.0.1:11434" });
  delete process.env.DAILY_BRIEF_MODE;
});
afterEach(() => { cfg.setSdkFactory(undefined); cfg.setClaudePlanClient(undefined); setVault(undefined); });

describe("defaults", () => {
  it("every job uses the Anthropic API with the extraction model until you pick something", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-real";
    for (const t of ["extraction", "ask", "assist", "nudges", "canvas"] as const) {
      expect(cfg.resolveTask(t)).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5-5", qualified: "claude-sonnet-5-5" });
    }
    expect(cfg.aiPrefs().search.localOnly).toBe(true);
  });
  it("extraction still follows the older Reading model choice", () => {
    saveExtractionPrefs({ provider: "ollama", ollamaModel: "llama3.1:8b", ollamaUrl: "http://127.0.0.1:11434" });
    expect(cfg.resolveTask("extraction")).toMatchObject({ provider: "ollama", qualified: "ollama:llama3.1:8b" });
  });
  it("a Reading model save replaces an Extraction pick", () => {
    cfg.saveAiPrefs((p) => { p.tasks.extraction = { provider: "openai", model: "m" }; });
    saveExtractionPrefs({ ...extractionPrefs(), provider: "claude" });
    expect(cfg.aiPrefs().tasks.extraction).toBeUndefined();
  });
});

describe("keys and clients", () => {
  it("keeps keys in the vault (Keychain or secret store) and shows only the last four", async () => {
    expect(await cfg.saveKey("openai", "sk-test-not-a-real-key-1234")).toBe(true);
    expect(vault.data.OPENAI_API_KEY).toBe("sk-test-not-a-real-key-1234");
    expect((await cfg.keyHints()).openai).toBe("••••1234");
    expect(await cfg.saveKey("anthropic", "sk-ant-xxxxxxxx")).toBe(false); // the Anthropic key stays where it was
    await cfg.removeKey("openai");
    expect(vault.data.OPENAI_API_KEY).toBeUndefined();
  });
  it("says what to set up when a key or base URL is missing", async () => {
    cfg.saveAiPrefs((p) => { p.tasks.ask = { provider: "groq", model: "g" }; });
    expect(await cfg.clientForTask("ask")).toMatchObject({ ok: false, error: "Add your Groq key in Settings › AI." });
    expect(await cfg.clientFor("compatible")).toEqual({ error: "Add the base URL for OpenAI-compatible (your base URL) in Settings › AI." });
    cfg.saveAiPrefs((p) => { p.providers.compatible = { baseUrl: "http://127.0.0.1:1234/v1" }; });
    expect("client" in (await cfg.clientFor("compatible"))).toBe(true); // key optional
    expect(sdkCalls.at(-1)).toMatchObject({ provider: "compatible", apiKey: null, baseUrl: "http://127.0.0.1:1234/v1" });
  });
  it("DeepSeek and xAI get their documented base URLs through the OpenAI SDK", async () => {
    await cfg.saveKey("deepseek", "sk-deepseek-test-0000");
    await cfg.clientFor("deepseek");
    expect(sdkCalls.at(-1)).toMatchObject({ provider: "deepseek", baseUrl: "https://api.deepseek.com" });
  });
});

describe("Claude plan", () => {
  it("needs no key, uses the injected client, is priced 'on your plan'", async () => {
    const fake = { messages: { create: vi.fn(async () => toolCall(TOOL_NAME, output)), stream: vi.fn() } };
    cfg.setClaudePlanClient(() => fake as never);
    cfg.saveAiPrefs((p) => { p.tasks.extraction = { provider: "claude-plan", model: "sonnet" }; });
    const r = await extractWithPrefs(input);
    expect(fake.messages.create).toHaveBeenCalledTimes(1);
    expect((fake.messages.create.mock.calls[0] as unknown as [{ model: string }])[0].model).toBe("claude-plan:sonnet");
    expect(r.newItems).toHaveLength(1);
    cfg.ensurePrices();
    cfg.installPrices();
    expect(cfg.priceFor("claude-plan:sonnet")).toMatchObject({ source: "plan" });
    expect(extractionCostInr("claude-plan:sonnet", { inputTokens: 1000, outputTokens: 100 })).toBe(0);
  });
  it("is hidden and refused in hosted mode, falling back to the default", async () => {
    process.env.DAILY_BRIEF_MODE = "hosted";
    cfg.saveAiPrefs((p) => { p.tasks.ask = { provider: "claude-plan", model: "sonnet" }; });
    expect(cfg.resolveTask("ask").provider).toBe("anthropic");
    expect(await cfg.clientFor("claude-plan")).toEqual({ error: "Your Claude plan (Claude Code) is only available in the Mac app." });
    expect((await cfg.testProvider("claude-plan")).ok).toBe(false);
    const { providersFor } = await import("@/lib/ai/providers");
    expect(providersFor(true).map((p) => p.id)).not.toContain("claude-plan");
    expect(providersFor(false).map((p) => p.id)).toContain("claude-plan");
  });
  it("words a missing sign-in its own way", () => {
    expect(cfg.messageFor("claude-plan", "auth")).toMatch(/isn't signed in/);
  });
});

describe("extraction on another provider", () => {
  it("uses the same schema and quote check, and logs the qualified model", async () => {
    await cfg.saveKey("openai", "sk-test-not-a-real-key-1234");
    cfg.saveAiPrefs((p) => { p.tasks.extraction = { provider: "openai", model: "some-model" }; });
    const claude = vi.fn();
    const r = await extractWithPrefs(input, undefined, { claude });
    expect(claude).not.toHaveBeenCalled();
    expect(r.newItems.map((i) => i.text)).toEqual(["Send Nitin the banner copy"]);
    expect(cfg.resolveTask("extraction").qualified).toBe("openai:some-model");
  });
  it("Anthropic picked explicitly keeps the Claude path (with the chosen model)", async () => {
    cfg.saveAiPrefs((p) => { p.tasks.extraction = { provider: "anthropic", model: "claude-opus-5-5" }; });
    const claude = vi.fn(async () => ({ newItems: [], closes: [], usage: { inputTokens: 1, outputTokens: 1 } }));
    await extractWithPrefs(input, undefined, { claude });
    expect(claude).toHaveBeenCalledWith(input, { model: "claude-opus-5-5" });
  });
  it("no key yet waits like a rejected key (auth)", async () => {
    cfg.saveAiPrefs((p) => { p.tasks.extraction = { provider: "mistral", model: "m" }; });
    await expect(extractWithPrefs(input)).rejects.toMatchObject({ kind: "auth" });
  });
  it("an unpriced model logs 0 instead of failing the read", () => {
    expect(extractionCostInr("groq:unknown", { inputTokens: 1000, outputTokens: 10 })).toBe(0);
  });
});

describe("Test and prices", () => {
  it("lists models (free), keeps them as suggestions, and OpenRouter's prices", async () => {
    await cfg.saveKey("openai", "sk-test-not-a-real-key-1234");
    const r = await cfg.testProvider("openai");
    expect(r).toMatchObject({ ok: true, models: ["model-one", "model-two"] });
    expect(cfg.aiPrefs().providers.openai?.models).toEqual(["model-one", "model-two"]);
    await cfg.saveKey("openrouter", "sk-or-test-00000000");
    await cfg.testProvider("openrouter");
    expect(cfg.priceFor("openrouter:vendor/a")).toEqual({ input: 1, output: 2, source: "openrouter" });
    expect(cfg.priceFor("openrouter:vendor/b")).toBeNull();
  });
  it("a rejected key is classified and shown as a problem for that provider", async () => {
    cfg.setSdkFactory(() => ({ models: { list: async () => { throw Object.assign(new Error("Incorrect API key"), { status: 401 }); } } }));
    await cfg.saveKey("xai", "xai-test-key-00000000");
    const r = await cfg.testProvider("xai");
    expect(r).toMatchObject({ ok: false, failure: "auth", message: "Your xAI API key was rejected. Check it in Settings." });
    expect(cfg.aiPrefs().problems.xai).toMatchObject({ kind: "auth" });
    cfg.clearProblem("xai");
    expect(cfg.aiPrefs().problems.xai).toBeUndefined();
  });
  it("prices you enter feed every cost line, marked as estimates", () => {
    cfg.saveAiPrefs((p) => { p.prices["groq:g"] = { input: 1, output: 1 }; });
    cfg.installPrices();
    expect(safeCostInr("groq:g", { inputTokens: 1_000_000, outputTokens: 0 })).toBeGreaterThan(0);
    expect(safeCostInr("ollama:x", { inputTokens: 1_000_000, outputTokens: 0 })).toBe(0);
    expect(safeCostInr("claude-sonnet-5-5", { inputTokens: 1_000_000, outputTokens: 0 })).toBeGreaterThan(0);
  });
});

describe("Canvas", () => {
  afterEach(() => { process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-real"; delete process.env.DAILY_BRIEF_CANVAS_AI; });
  it("follows the Canvas pick in Settings › AI", async () => {
    await cfg.saveKey("groq", "gsk-test-not-real-000");
    cfg.saveAiPrefs((p) => { p.tasks.canvas = { provider: "groq", model: "fast" }; });
    const { canvasAi } = await import("@/server/canvas/data");
    const ai = await canvasAi();
    expect(ai).toMatchObject({ model: "groq:fast", via: "Groq · fast", provider: "groq" });
    expect(sdkCalls.at(-1)).toMatchObject({ provider: "groq" });
  });
  it("with nothing picked: the Anthropic key, else your Claude plan, never in hosted mode", () => {
    cfg.setClaudePlanClient(() => ({ messages: { create: vi.fn(), stream: vi.fn() } }) as never); // stands in for an installed Claude Code
    expect(cfg.resolveTask("canvas").provider).toBe("anthropic");
    delete process.env.ANTHROPIC_API_KEY;
    expect(cfg.resolveTask("canvas")).toMatchObject({ provider: "claude-plan", qualified: "claude-plan:sonnet" });
    process.env.DAILY_BRIEF_CANVAS_AI = "key";
    expect(cfg.resolveTask("canvas").provider).toBe("anthropic");
    delete process.env.DAILY_BRIEF_CANVAS_AI;
    expect(cfg.resolveTask("canvas", cfg.aiPrefs(), true).provider).toBe("anthropic");
    cfg.saveAiPrefs((p) => { p.tasks.canvas = { provider: "claude-plan", model: "opus" }; });
    expect(cfg.resolveTask("canvas", cfg.aiPrefs(), true).provider).toBe("anthropic");
  });
});
