// Fakes for the Anthropic client in tests. Nothing here touches the network.
import type Anthropic from "@anthropic-ai/sdk";

export function message(content: Anthropic.ContentBlock[], over: Partial<Anthropic.Message> = {}): Anthropic.Message {
  return {
    id: "msg_test", type: "message", role: "assistant", model: "claude-sonnet-5-5", content,
    stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: null },
    ...over,
  } as Anthropic.Message;
}

export function toolCall(name: string, input: unknown, over: Partial<Anthropic.Message> = {}): Anthropic.Message {
  return message([{ type: "tool_use", id: "toolu_1", name, input } as Anthropic.ContentBlock], { stop_reason: "tool_use", ...over });
}

/** A create() client that returns the given replies in order and records each request. */
export function fakeCreate(...replies: Array<Anthropic.Message | Error>) {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  return {
    calls,
    messages: {
      async create(body: Anthropic.MessageCreateParamsNonStreaming) {
        calls.push(body);
        const r = replies.shift();
        if (!r) throw new Error("unexpected call");
        if (r instanceof Error) throw r;
        return r;
      },
    },
  };
}

/** A stream() client yielding text deltas, then finalMessage(). */
export function fakeStream(chunks: string[], final: Partial<Anthropic.Message> = {}, fail?: Error) {
  const calls: Anthropic.MessageStreamParams[] = [];
  return {
    calls,
    messages: {
      stream(body: Anthropic.MessageStreamParams) {
        calls.push(body);
        return {
          async *[Symbol.asyncIterator](): AsyncIterator<Anthropic.MessageStreamEvent> {
            if (fail) throw fail;
            for (const text of chunks) yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } as Anthropic.MessageStreamEvent;
          },
          finalMessage: async () => message([{ type: "text", text: chunks.join(""), citations: null } as Anthropic.ContentBlock], final),
        };
      },
    },
  };
}
