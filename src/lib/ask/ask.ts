// Ask: stream an answer to one question from up to 40 local items, cited as [n].
// Streaming via client.messages.stream (SDK MessageStream): text deltas go to the page as they
// arrive and finalMessage() gives the usage for the cost line.
import type Anthropic from "@anthropic-ai/sdk";
import { approxTokens, safeCostInr, usageOf, type Usage } from "../ai/common";
import type { AnthropicFailure } from "../extract/errors";
import { classifyProviderError } from "../ai/errors";
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

/** An earlier question and answer in the same thread, sent as conversation history. */
export interface AskTurnContext { question: string; answer: string }

export interface AskInput {
  /** Earlier turns of this thread (oldest first), for follow-ups. */
  history?: AskTurnContext[];
  question: string;
  sources: Source[];
  userName: string;
  timeZone: string;
  now: Date;
}

/** Approximate rupees for one question with these sources, or null when the model has no price. */
export function estimateCost(input: AskInput, model: string): { inputTokens: number; costInr: number | null } {
  const chars = ASK_SYSTEM_PROMPT.length + buildAskMessage(input.question, input.sources, input).length +
    historyMessages(input.history).reduce((n, m) => n + String(m.content).length, 0);
  const inputTokens = approxTokens(chars);
  return { inputTokens, costInr: safeCostInr(model, { inputTokens, outputTokens: ASK_EST_OUTPUT_TOKENS }) };
}

/** True when the answer is the "nothing supports it" reply. */
export const isNoAnswer = (text: string) => text.trim().replace(/[’]/g, "'").startsWith(NO_ANSWER.slice(0, -1));

/**
 * Yields text chunks, then one done (or error) event. With no sources it answers NO_ANSWER without
 * calling the model. Never throws: API failures become an error event with a short message.
 */
/** Earlier turns as alternating messages, citation numbers dropped (they pointed at other sources). */
export function historyMessages(history: AskTurnContext[] = []): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const h of history.slice(-6)) {
    const answer = h.answer.replace(/\s*\[\d{1,3}(?:\s*,\s*\d{1,3})*\]/g, "").trim();
    if (!h.question.trim() || !answer) continue;
    out.push({ role: "user", content: `Earlier question: ${h.question}` }, { role: "assistant", content: answer });
  }
  return out;
}

export async function* streamAnswer(input: AskInput, deps: { client: StreamingClient; model: string; signal?: AbortSignal; who?: { account: string; model: string } }): AsyncGenerator<AskEvent> {
  const who = deps.who ?? { account: "Anthropic", model: "Claude" };
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
        messages: [...historyMessages(input.history), { role: "user", content: buildAskMessage(input.question, input.sources, input) }],
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
      yield { type: "error", error: `${who.model} declined to answer that one.` };
      return;
    }
    if (stop === "max_tokens") yield { type: "text", text: text ? " …" : NO_ANSWER };
    yield { type: "done", usage, costInr: safeCostInr(deps.model, usage), noAnswer: !text.trim() || isNoAnswer(text) };
  } catch (e) {
    if (deps.signal?.aborted) return;
    // No retries here: someone is waiting. Key and credit problems say what to fix.
    const failure = classifyProviderError(e);
    const error =
      failure === "auth" ? `Your ${who.account} API key was rejected. Check it in Settings.`
      : failure === "credit" ? `Your ${who.account} account is out of credit. Add credit, then ask again.`
      : failure === "offline" ? `Couldn't reach ${who.model}. Check your connection and try again.`
      : failure === "transient" ? `${who.model} is busy right now. Try again in a minute.`
      : `${who.model} couldn't answer that. Try again.`;
    yield { type: "error", error, failure };
  }
}
