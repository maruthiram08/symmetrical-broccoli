import { safeCostInr } from "@/lib/ai/common";
import { extractMeeting } from "@/lib/extract/extract";
import { AnthropicCallError } from "@/lib/extract/errors";
import { extractMeetingOllama, type FetchLike } from "@/lib/extract/ollama";
import type { ExtractionInput, ExtractionResult } from "@/lib/types";
import { aiPrefs, clientFor, ensurePrices, noteProblem, resolveTask, type AiPrefs } from "@/server/ai-config";
import { extractionPrefs, type ExtractionPrefs } from "./prefs";

/**
 * Reads one meeting with the model chosen in Settings: Claude (the default, unchanged), the older
 * Local (Ollama) choice, or any provider picked for Extraction in Settings › AI. Every provider gets
 * the same prompt, output schema and quote check (postProcess).
 */
export async function extractWithPrefs(
  input: ExtractionInput,
  prefs: ExtractionPrefs = extractionPrefs(),
  deps: { claude?: typeof extractMeeting; fetch?: FetchLike; ai?: AiPrefs } = {},
): Promise<ExtractionResult> {
  const ai = deps.ai ?? aiPrefs();
  const chosen = ai.tasks.extraction;
  if (!chosen) {
    if (prefs.provider === "ollama") return extractMeetingOllama(input, { url: prefs.ollamaUrl, model: prefs.ollamaModel, fetch: deps.fetch });
    return (deps.claude ?? extractMeeting)(input);
  }
  const t = resolveTask("extraction", ai);
  if (t.provider === "anthropic") return (deps.claude ?? extractMeeting)(input, chosen.model.trim() ? { model: t.model } : {});
  if (t.provider === "ollama") return extractMeetingOllama(input, { url: ai.providers.ollama?.baseUrl || prefs.ollamaUrl, model: t.model, fetch: deps.fetch });
  const c = await clientFor(t.provider, ai);
  // No key yet: counted like a rejected key, so the meeting waits until one is added.
  if ("error" in c) throw new AnthropicCallError("auth", 401);
  try {
    return await extractMeeting(input, { client: c.client, model: t.qualified });
  } catch (e) {
    if (e instanceof AnthropicCallError) noteProblem(t.provider, e.kind);
    throw e;
  }
}

/** A local model costs nothing per meeting; an unpriced model logs 0 rather than failing the read. */
export function extractionCostInr(model: string, usage: ExtractionResult["usage"]): number {
  ensurePrices();
  return model.startsWith("ollama:") ? 0 : safeCostInr(model, usage) ?? 0;
}
