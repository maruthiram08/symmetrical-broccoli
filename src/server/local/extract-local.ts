import { costInr } from "@/lib/extract/cost";
import { extractMeeting } from "@/lib/extract/extract";
import { extractMeetingOllama, type FetchLike } from "@/lib/extract/ollama";
import type { ExtractionInput, ExtractionResult } from "@/lib/types";
import { extractionPrefs, type ExtractionPrefs } from "./prefs";

/** Reads one meeting with the model chosen in Settings (Claude unless you picked Local). */
export function extractWithPrefs(
  input: ExtractionInput,
  prefs: ExtractionPrefs = extractionPrefs(),
  deps: { claude?: typeof extractMeeting; fetch?: FetchLike } = {},
): Promise<ExtractionResult> {
  if (prefs.provider === "ollama") return extractMeetingOllama(input, { url: prefs.ollamaUrl, model: prefs.ollamaModel, fetch: deps.fetch });
  return (deps.claude ?? extractMeeting)(input);
}

/** A local model costs nothing per meeting. */
export function extractionCostInr(model: string, usage: ExtractionResult["usage"]): number {
  return model.startsWith("ollama:") ? 0 : costInr(model, usage);
}
