// App preferences that the Settings page changes and that aren't about your user record:
// which model reads meetings. Kept in <data>/prefs.json (0600).
import { join } from "node:path";
import { env } from "@/lib/env";
import { homeDataDir as dataDir } from "./workspaces";
import { readJson, writeJson } from "./json-file";

export type ExtractionProvider = "claude" | "ollama";

export interface ExtractionPrefs {
  provider: ExtractionProvider;
  ollamaModel: string;
  ollamaUrl: string;
}

export const OLLAMA_DEFAULTS = { ollamaModel: "qwen2.5:14b", ollamaUrl: "http://127.0.0.1:11434" } as const;
const DEFAULTS: ExtractionPrefs = { provider: "claude", ...OLLAMA_DEFAULTS };

interface Prefs { extraction?: Partial<ExtractionPrefs> }

export const prefsPath = () => join(dataDir(), "prefs.json");

export function extractionPrefs(path = prefsPath()): ExtractionPrefs {
  const e = readJson<Prefs>(path, {}).extraction ?? {};
  return {
    provider: e.provider === "ollama" ? "ollama" : "claude",
    ollamaModel: typeof e.ollamaModel === "string" && e.ollamaModel ? e.ollamaModel : DEFAULTS.ollamaModel,
    ollamaUrl: typeof e.ollamaUrl === "string" && e.ollamaUrl ? e.ollamaUrl : DEFAULTS.ollamaUrl,
  };
}

export function saveExtractionPrefs(p: ExtractionPrefs, path = prefsPath()): void {
  const all = readJson<Prefs & { ai?: { tasks?: Record<string, unknown> } }>(path, {});
  // This older "Reading model" choice wins over an Extraction pick in Settings › AI.
  if (all.ai?.tasks) delete all.ai.tasks.extraction;
  writeJson(path, { ...all, extraction: p });
}

/** Ollama's model names: letters, digits and . _ : / - (say "qwen2.5:14b" or "library/llama3.1:8b"). */
export const OLLAMA_MODEL = /^[A-Za-z0-9._:/-]{1,100}$/;

/** http(s) URL with no credentials or path tricks. */
export function validOllamaUrl(u: string): string | null {
  try {
    const url = new URL(u.trim());
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** The model name logged with each read: the Claude model, or "ollama:<model>". */
export function extractionModelName(p: ExtractionPrefs = extractionPrefs()): string {
  return p.provider === "ollama" ? `ollama:${p.ollamaModel}` : env.extractionModel;
}
