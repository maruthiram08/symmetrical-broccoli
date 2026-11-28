// Writing assist in the notes editor: select text, then Tidy, Shorter, Make it a Slack message or
// Translate Hinglish to English. One model call, same conventions as src/lib/ai/common.ts: the
// extraction model setting, one tool whose input is the output, tool_choice auto, no thinking.
// Only the selected text goes to Claude. Nothing is sent anywhere else.
import type Anthropic from "@anthropic-ai/sdk";
import { approxTokens, safeCostInr, toolInput, usageOf, type Usage } from "../ai/common";
import { classifyAnthropicError, type AnthropicFailure } from "../extract/errors";
import type { AnthropicLike } from "../extract/extract";

export const ASSIST_MODES = ["tidy", "shorter", "slack", "translate"] as const;
export type AssistMode = (typeof ASSIST_MODES)[number];

export const ASSIST_LABELS: Record<AssistMode, string> = {
  tidy: "Tidy",
  shorter: "Shorter",
  slack: "Make it a Slack message",
  translate: "Translate Hinglish to English",
};

/** Longest selection sent, in characters. */
export const ASSIST_MAX_CHARS = 8000;
export const ASSIST_MAX_TOKENS = 4000;
const TOOL_NAME = "write_text";

const ASK: Record<AssistMode, string> = {
  tidy: "Tidy the text: fix spelling, grammar and punctuation, and make it read cleanly. Keep the meaning, the voice, the language (Hinglish stays Hinglish) and roughly the length. Keep its Markdown (lists, checkboxes, links, headings) as it is.",
  shorter: "Make the text shorter: about half the length, keeping every fact, name, number, date and promise. Keep its language and its Markdown (lists stay lists, [[links]] stay as they are).",
  slack: "Rewrite the text as one Slack message the user could send: first person, plain, friendly, short paragraphs or a short list, no greeting fluff, no sign-off, no emoji, no headings. Keep every fact, name, number and date. Turn [[links]] into their plain label.",
  translate: "Translate the text from Hinglish (Hindi and English mixed, often in Latin script) into natural, plain English. Keep names, numbers, dates and Markdown as they are. Text that is already English stays as it is.",
};

export const ASSIST_SYSTEM_PROMPT = `You edit a short piece of a person's own notes. You get the text and one instruction, and return only the rewritten text by calling the ${TOOL_NAME} tool exactly once. Do not answer in plain text.

Rules
- Never invent facts, names, numbers, dates or promises. Never drop a name, number, date or promise.
- [[double bracket links]] are links: keep them exactly unless the instruction says otherwise.
- No preamble, no quotes around the result, no notes about what you changed.`;

const TOOL: Anthropic.Tool = {
  name: TOOL_NAME,
  description: "Record the rewritten text. Call exactly once.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["text"],
    properties: { text: { type: "string", description: "The rewritten text, Markdown allowed." } },
  },
};

export function buildAssistMessage(mode: AssistMode, text: string): string {
  return `Instruction: ${ASK[mode]}\n\n<text>\n${text}\n</text>`;
}

/** Rough cost shown before running. Output is assumed about as long as the input. */
export function estimateAssist(mode: AssistMode, text: string, model: string): { inputTokens: number; outputTokens: number; costInr: number | null } {
  const inputTokens = approxTokens(ASSIST_SYSTEM_PROMPT.length + buildAssistMessage(mode, text).length) + 120;
  const outputTokens = Math.max(60, approxTokens(mode === "shorter" ? text.length / 2 : text.length) + 40);
  return { inputTokens, outputTokens, costInr: safeCostInr(model, { inputTokens, outputTokens }) };
}

export type AssistResult =
  | { ok: true; text: string; usage: Usage; costInr: number | null }
  | { ok: false; error: string; failure?: AnthropicFailure; usage?: Usage; costInr?: number | null };

/** The message for a failed call, the same words Ask uses. */
export function assistError(failure: AnthropicFailure): string {
  return failure === "auth" ? "Your Anthropic API key was rejected. Check it in Settings."
    : failure === "credit" ? "Your Anthropic account is out of credit. Add credit, then try again."
    : failure === "offline" ? "Couldn't reach Claude. Check your connection and try again."
    : failure === "transient" ? "Claude is busy right now. Try again in a minute."
    : "Claude couldn't do that one. Try again.";
}

/** One call, no retries (someone is waiting). Never throws. */
export async function runAssist(mode: AssistMode, text: string, deps: { client: AnthropicLike; model: string; signal?: AbortSignal }): Promise<AssistResult> {
  const src = text.trim();
  if (!src) return { ok: false, error: "Select some text first." };
  if (src.length > ASSIST_MAX_CHARS) return { ok: false, error: `Select less text (up to ${ASSIST_MAX_CHARS.toLocaleString("en-IN")} characters).` };
  let r: Anthropic.Message;
  try {
    r = await deps.client.messages.create({
      model: deps.model,
      max_tokens: ASSIST_MAX_TOKENS,
      system: ASSIST_SYSTEM_PROMPT,
      tools: [TOOL],
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      messages: [{ role: "user", content: buildAssistMessage(mode, src) }],
    }, deps.signal ? { signal: deps.signal } : undefined);
  } catch (e) {
    const failure = classifyAnthropicError(e);
    return { ok: false, error: assistError(failure), failure };
  }
  const usage = usageOf(r);
  const costInr = safeCostInr(deps.model, usage);
  const stop = r.stop_reason as string | null;
  if (stop === "refusal") return { ok: false, error: "Claude declined that one.", usage, costInr };
  if (stop === "max_tokens") return { ok: false, error: "That was too long to rewrite. Select less text.", usage, costInr };
  const input = toolInput(r, TOOL_NAME) as { text?: unknown } | null;
  let out = typeof input?.text === "string" ? input.text : "";
  if (!out) {
    // Some replies come back as plain text: take it rather than fail.
    out = r.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
  }
  out = out.replace(/^\s*<text>\n?|\n?<\/text>\s*$/g, "").trim();
  if (!out) return { ok: false, error: "Claude didn't return any text. Try again.", usage, costInr };
  // Keep the selection's surrounding whitespace, so replacing it doesn't glue lines together.
  const lead = text.match(/^\s*/)![0], trail = text.match(/\s*$/)![0];
  return { ok: true, text: lead + out + trail, usage, costInr };
}
