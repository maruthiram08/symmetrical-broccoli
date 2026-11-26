// Cost estimates shown in Settings › AI and Compare. Estimates only: list prices (Anthropic's from
// cost.ts, OpenRouter's from its model list, or prices you entered) times typical token counts.
import { USD_TO_INR } from "../extract/cost";
import { formatInr } from "./common";
import { splitModel, type AiTask } from "./providers";

/** Typical tokens per use, measured on the eval meetings for extraction; rough for the rest. */
export const TYPICAL: Record<AiTask, { input: number; output: number; per: string }> = {
  extraction: { input: 12_000, output: 1_600, per: "a meeting" },
  ask: { input: 4_000, output: 800, per: "a question" },
  assist: { input: 1_200, output: 500, per: "a rewrite" },
  nudges: { input: 700, output: 150, per: "a nudge" },
};

export type Price = { input: number; output: number };

export function inrFor(price: Price, tokens: { input: number; output: number }): number {
  return ((tokens.input * price.input + tokens.output * price.output) / 1_000_000) * USD_TO_INR;
}

/** "≈ ₹3.50 a meeting (estimate)", "Free: runs on this computer", "On your plan", or why there is none. */
export function estimateLabel(qualified: string, prices: Record<string, Price>, task: AiTask): string {
  const { provider } = splitModel(qualified);
  if (provider === "ollama") return "Free: runs on this computer";
  if (provider === "claude-plan") return "On your plan: no per-call charge";
  const p = prices[qualified];
  if (!p) return "Price unknown: add it under Prices to see an estimate";
  const t = TYPICAL[task];
  return `≈ ${formatInr(inrFor(p, t))} ${t.per} (estimate)`;
}
