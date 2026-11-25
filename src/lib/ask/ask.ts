// Ask: stream an answer to one question from up to 40 local items, cited as [n].
// Streaming via client.messages.stream (SDK MessageStream): text deltas go to the page as they
// arrive and finalMessage() gives the usage for the cost line.
import type Anthropic from "@anthropic-ai/sdk";
import { approxTokens, safeCostInr, usageOf, type Usage } from "../ai/common";
import { classifyAnthropicError, type AnthropicFailure } from "../extract/errors";
import { ASK_SYSTEM_PROMPT, NO_ANSWER, buildAskMessage } from "./prompt";
import type { Source } from "./retrieve";

/** Thinking tokens count toward this too; the answer itself is a few hundred tokens. */
export const ASK_MAX_TOKENS = 3000;
/** Output tokens assumed by the estimate shown before asking (answer plus some thinking). */
export const ASK_EST_OUTPUT_TOKENS = 800;

/** The part of the Anthropic client Ask uses, so tests can pass a fake stream. */
export interface StreamingClient {
  messages: {
    stream(body: Anthropic.MessageStreamParams, options?: Anthropic.RequestOptions): AsyncIterable<Anthropic.MessageStreamEvent> & {
      finalMessage(): Promise<Anthropic.Message>;
    };
  };
}

export type AskEvent =
  | { type: "text"; text: string }
  | { type: "done"; usage: Usage | null; costInr: number | null; noAnswer: boolean }
  | { type: "error"; error: string; failure?: AnthropicFailure };

export interface AskInput {
  question: string;
  sources: Source[];
  userName: string;
  timeZone: string;
  now: Date;
}

/** Approximate rupees for one question with these sources, or null when the model has no price. */
export function estimateCost(input: AskInput, model: string): { inputTokens: number; costInr: number | null } {
  const chars = ASK_SYSTEM_PROMPT.length + buildAskMessage(input.question, input.sources, input).length;
  const inputTokens = approxTokens(chars);
  return { inputTokens, costInr: safeCostInr(model, { inputTokens, outputTokens: ASK_EST_OUTPUT_TOKENS }) };
}

/** True when the answer is the "nothing supports it" reply. */
export const isNoAnswer = (text: string) => text.trim().replace(/[’]/g, "'").startsWith(NO_ANSWER.slice(0, -1));

/**
 * Yields text chunks, then one done (or error) event. With no sources it answers NO_ANSWER without
 * calling the model. Never throws: API failures become an error event with a short message.
 */
export async function* streamAnswer(input: AskInput, deps: { client: StreamingClient; model: string; signal?: AbortSignal }): AsyncGenerator<AskEvent> {
  if (!input.sources.length) {
    yield { type: "text", text: NO_ANSWER };
    yield { type: "done", usage: null, costInr: 0, noAnswer: true };
    return;
  }
  let text = "";
  try {
    const stream = deps.client.messages.stream(
      {
        model: deps.model,
        max_tokens: ASK_MAX_TOKENS,
        system: ASK_SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildAskMessage(input.question, input.sources, input) }],
      },
      deps.signal ? { signal: deps.signal } : undefined,
    );
    for await (const ev of stream) {
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta" && ev.delta.text) {
        text += ev.delta.text;
        yield { type: "text", text: ev.delta.text };
      }
    }
    const final = await stream.finalMessage();
    const usage = usageOf(final);
    const stop = final.stop_reason as string | null;
    if (stop === "refusal") {
      yield { type: "error", error: "Claude declined to answer that one." };
      return;
    }
    if (stop === "max_tokens") yield { type: "text", text: text ? " …" : NO_ANSWER };
    yield { type: "done", usage, costInr: safeCostInr(deps.model, usage), noAnswer: !text.trim() || isNoAnswer(text) };
  } catch (e) {
    if (deps.signal?.aborted) return;
    // No retries here: someone is waiting. Key and credit problems say what to fix.
    const failure = classifyAnthropicError(e);
    const error =
      failure === "auth" ? "Your Anthropic API key was rejected. Check it in Settings."
      : failure === "credit" ? "Your Anthropic account is out of credit. Add credit, then ask again."
      : failure === "offline" ? "Couldn't reach Claude. Check your connection and try again."
      : failure === "transient" ? "Claude is busy right now. Try again in a minute."
      : "Claude couldn't answer that. Try again.";
    yield { type: "error", error, failure };
  }
}
