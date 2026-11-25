// Rough cost of an extraction call in rupees.
//
// PLACEHOLDER PRICES: verify against https://www.anthropic.com/pricing (and the current USD to INR
// rate) before relying on these numbers. They are list prices per million tokens at the time of
// writing and ignore prompt-cache discounts, batch discounts and taxes.
import type { ExtractionResult } from "../types";

/** USD per million tokens. PLACEHOLDER: verify against current pricing. */
export const PRICES_USD_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
};

/** PLACEHOLDER: rupees per US dollar. Update to the current rate. */
export const USD_TO_INR = 88;

export function costUsd(model: string, usage: ExtractionResult["usage"]): number {
  const price = PRICES_USD_PER_MTOK[model];
  if (!price) throw new Error(`No price for model "${model}". Add it to PRICES_USD_PER_MTOK in src/lib/extract/cost.ts.`);
  return (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000;
}

export function costInr(model: string, usage: ExtractionResult["usage"]): number {
  return costUsd(model, usage) * USD_TO_INR;
}

/**
 * What one meeting's read costs on average, in rupees, for estimates shown before reading
 * ("about ₹3.50 per meeting" in Settings). Measured on the eval meetings; long ones cost more.
 */
export const COST_PER_MEETING_INR = 3.5;
