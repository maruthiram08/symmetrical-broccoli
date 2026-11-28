// Shared bits for the small AI features (Ask, nudges, contradiction catch). Same API approach as
// src/lib/extract/extract.ts: the extraction model setting, one tool whose input is the output,
// tool_choice auto (current default models reject a forced tool_choice), no thinking param.
import type Anthropic from "@anthropic-ai/sdk";
import { costInr } from "../extract/cost";

export type Usage = { inputTokens: number; outputTokens: number };

export function usageOf(m: Pick<Anthropic.Message, "usage">): Usage {
  const u = m.usage;
  return {
    inputTokens: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
    outputTokens: u.output_tokens,
  };
}

/** Rupees, or null when the model has no price in cost.ts. Never throws. */
export function safeCostInr(model: string, usage: Usage): number | null {
  try { return costInr(model, usage); } catch { return null; }
}

/** The input of the named tool call, or null. */
export function toolInput(m: Pick<Anthropic.Message, "content">, name: string): unknown {
  const b = m.content.find((x): x is Anthropic.ToolUseBlock => x.type === "tool_use" && x.name === name);
  return b ? b.input : null;
}

/** Rough token count for English-ish text (about 4 characters a token, rounded up). */
export const approxTokens = (chars: number) => Math.ceil(chars / 4);

/** "₹0.42", or "under ₹0.01". */
export function formatInr(n: number | null): string | null {
  if (n == null) return null;
  if (n < 0.01) return "under ₹0.01";
  return `₹${n < 10 ? n.toFixed(2) : n.toFixed(0)}`;
}
