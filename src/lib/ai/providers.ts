// The AI providers Daily brief can use, and the four jobs each can be picked for. Pure data, safe to
// import on the client. Model names are never hard-coded here except where the repo already uses
// them (the Anthropic prices in cost.ts, the Ollama defaults, the Claude Code CLI aliases): the
// model field is free text, and Settings › AI › Test fills suggestions from the provider's own list.
import type { SecretName } from "@/server/local/keychain";
import { PRICES_USD_PER_MTOK } from "../extract/cost";

export const PROVIDER_IDS = [
  "anthropic", "openai", "gemini", "openrouter", "groq", "deepseek", "mistral", "xai", "compatible", "ollama", "claude-plan",
] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** How an extraction call asks for structured output when the provider has a choice. */
export type StructuredMode = "json_schema" | "tool";

/** Which client library talks to the provider (see adapters.ts). */
export type ProviderSdk = "anthropic" | "openai" | "groq" | "gemini" | "mistral" | "openrouter" | "ollama" | "claude-plan";

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  /** Keychain / secret store name, or null when the provider needs no key. */
  key: SecretName | null;
  /** A key is optional (an OpenAI-compatible server on your own network may not want one). */
  keyOptional?: boolean;
  sdk: ProviderSdk;
  /** Documented API base URL, editable in Settings. Null: the SDK's own default. */
  baseUrl: string | null;
  /** The base URL must be entered (OpenAI-compatible). */
  needsBaseUrl?: boolean;
  /** Default structured-output mode for extraction. */
  structured: StructuredMode;
  /** Where to get a key. */
  keyUrl?: string;
  /** Suggestions shipped with the app. Others come from the provider's model list (Test). */
  suggestions: string[];
  /** Runs on this computer: nothing leaves it. */
  local?: boolean;
  /** Only in the local app; refused in hosted mode. */
  localOnly?: boolean;
  /** One line under the provider in Settings. */
  note?: string;
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  anthropic: {
    id: "anthropic", label: "Anthropic (Claude API)", key: "ANTHROPIC_API_KEY", sdk: "anthropic", baseUrl: null, structured: "tool",
    keyUrl: "https://console.anthropic.com/settings/keys", suggestions: Object.keys(PRICES_USD_PER_MTOK),
    note: "The default. Best tested on Hinglish, hedged promises and closing items.",
  },
  openai: {
    id: "openai", label: "OpenAI", key: "OPENAI_API_KEY", sdk: "openai", baseUrl: null, structured: "json_schema",
    keyUrl: "https://platform.openai.com/api-keys", suggestions: [],
  },
  gemini: {
    id: "gemini", label: "Google Gemini", key: "GEMINI_API_KEY", sdk: "gemini", baseUrl: null, structured: "json_schema",
    keyUrl: "https://aistudio.google.com/apikey", suggestions: [],
  },
  openrouter: {
    id: "openrouter", label: "OpenRouter", key: "OPENROUTER_API_KEY", sdk: "openrouter", baseUrl: null, structured: "tool",
    keyUrl: "https://openrouter.ai/keys", suggestions: [], note: "Prices come from OpenRouter's model list after Test.",
  },
  groq: {
    id: "groq", label: "Groq", key: "GROQ_API_KEY", sdk: "groq", baseUrl: null, structured: "tool",
    keyUrl: "https://console.groq.com/keys", suggestions: [],
  },
  deepseek: {
    id: "deepseek", label: "DeepSeek", key: "DEEPSEEK_API_KEY", sdk: "openai", baseUrl: "https://api.deepseek.com", structured: "tool",
    keyUrl: "https://platform.deepseek.com/api_keys", suggestions: [], note: "Uses the OpenAI SDK, as DeepSeek's docs describe.",
  },
  mistral: {
    id: "mistral", label: "Mistral", key: "MISTRAL_API_KEY", sdk: "mistral", baseUrl: null, structured: "json_schema",
    keyUrl: "https://console.mistral.ai/api-keys", suggestions: [],
  },
  xai: {
    id: "xai", label: "xAI", key: "XAI_API_KEY", sdk: "openai", baseUrl: "https://api.x.ai/v1", structured: "json_schema",
    keyUrl: "https://console.x.ai", suggestions: [], note: "Uses the OpenAI SDK, as xAI's docs describe.",
  },
  compatible: {
    id: "compatible", label: "OpenAI-compatible (your base URL)", key: "COMPATIBLE_API_KEY", keyOptional: true, sdk: "openai",
    baseUrl: null, needsBaseUrl: true, structured: "tool", suggestions: [],
    note: "Any server that speaks the OpenAI chat completions API: LM Studio, vLLM, LiteLLM, a company gateway.",
  },
  ollama: {
    id: "ollama", label: "Ollama (on this computer)", key: null, sdk: "ollama", baseUrl: "http://127.0.0.1:11434", structured: "json_schema",
    suggestions: ["qwen2.5:14b", "llama3.1:8b"], local: true, note: "Nothing leaves this computer, and it costs nothing per call.",
  },
  "claude-plan": {
    id: "claude-plan", label: "Your Claude plan (Claude Code)", key: null, sdk: "claude-plan", baseUrl: null, structured: "tool",
    suggestions: ["sonnet", "opus", "haiku"], localOnly: true,
    note: "Uses your own Claude Code sign-in on this Mac. For personal use.",
  },
};

export const AI_TASKS = ["extraction", "ask", "assist", "nudges", "canvas"] as const;
export type AiTask = (typeof AI_TASKS)[number];

export const TASK_LABELS: Record<AiTask, { label: string; hint: string }> = {
  extraction: { label: "Extraction", hint: "Reads each meeting: what you owe, wait on and decided." },
  ask: { label: "Ask", hint: "Answers questions from the passages local search finds." },
  assist: { label: "Writing assist", hint: "Tidy, Shorter, Slack message and Translate in notes." },
  nudges: { label: "Nudges", hint: "Drafts nudges for late promises, and checks changed decisions." },
  canvas: { label: "Canvas", hint: "Ask on the canvas, and the draft window when you start an item." },
};

export function isProviderId(v: unknown): v is ProviderId {
  return typeof v === "string" && (PROVIDER_IDS as readonly string[]).includes(v);
}

/** Providers offered in this mode: Claude plan only in the local app. */
export function providersFor(hosted: boolean): ProviderInfo[] {
  return PROVIDER_IDS.map((id) => PROVIDERS[id]).filter((p) => !(hosted && p.localOnly));
}

/**
 * The model name used for logs and prices: Anthropic models as they are ("claude-sonnet-5-5", so
 * nothing changes for the default), every other provider as "<provider>:<model>" ("ollama:qwen2.5:14b").
 */
export function qualifiedModel(provider: ProviderId, model: string): string {
  return provider === "anthropic" ? model : `${provider}:${model}`;
}

/** Back from a qualified name to the provider and the model the API wants. */
export function splitModel(qualified: string): { provider: ProviderId; model: string } {
  const i = qualified.indexOf(":");
  if (i > 0) {
    const p = qualified.slice(0, i);
    if (isProviderId(p) && p !== "anthropic") return { provider: p, model: qualified.slice(i + 1) };
  }
  return { provider: "anthropic", model: qualified };
}

/** Model names people type: letters, digits and . _ : / @ - + (no spaces or quotes). */
export const MODEL_NAME = /^[A-Za-z0-9._:/@+-]{1,160}$/;
