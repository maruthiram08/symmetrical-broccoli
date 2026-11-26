// The model a cross-check uses: the provider and model picked for Extraction in Settings › AI
// (Anthropic by default; any other provider, including your Claude plan, works the same way).
import type { AnthropicLike } from "@/lib/extract/extract";
import { AnthropicCallError } from "@/lib/extract/errors";
import { clientForTask, ensurePrices, noteProblem } from "@/server/ai-config";
import type { ProviderId } from "@/lib/ai/providers";

/** Notes a key or credit problem for Settings › AI instead of raising the Anthropic banner. */
function noted(client: AnthropicLike, provider: ProviderId): AnthropicLike {
  return {
    messages: {
      async create(body, options) {
        try {
          return await client.messages.create(body, options);
        } catch (e) {
          if (e instanceof AnthropicCallError) noteProblem(provider, e.kind);
          throw e;
        }
      },
    },
  };
}

export async function extractionModel(): Promise<{ client: AnthropicLike; model: string; provider: string } | { error: string }> {
  ensurePrices();
  const r = await clientForTask("extraction");
  if (!r.ok) return { error: r.error };
  // The qualified name ("claude-plan:sonnet", "openai:gpt-…"; the bare id for Anthropic): every client takes it.
  return { client: noted(r.client, r.resolved.provider), model: r.resolved.qualified, provider: r.resolved.provider };
}
