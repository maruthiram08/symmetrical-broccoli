import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type { ExtractionInput } from "../types";
import { QUOTE_MAX } from "../types";
import {
  ExtractionError,
  extractMeeting,
  normalize,
  truncateQuote,
  type AnthropicLike,
} from "./extract";
import { TOOL_NAME, buildUserMessage, formatLocal } from "./prompt";
import { costInr, USD_TO_INR } from "./cost";

const transcript = `Nitin: Maruthi, can you send me the final banner text?
Maruthi: Haan, main “half an hour” mein bhej deta hoon, don't worry.
Nitin: Cool. I’ll push the build to staging by 5.
Maruthi: Also the tooltip copy wala thing — I already shared it on Slack.
Nitin: Ok so we go with the blue banner, final.`;

const input: ExtractionInput = {
  transcript,
  user: { name: "Maruthi", aliases: ["Maru"], timeZone: "Asia/Kolkata" },
  meeting: {
    title: "Dividend banner",
    startedAt: "2026-11-25T08:21:00.000Z", // 13:51 IST
    participants: ["Maruthi", "Nitin"],
  },
  openItems: [{ id: "item-1", kind: "owe", text: "Share tooltip copy with Nitin", person: "Nitin" }],
};

function fakeClient(toolInput: unknown, overrides: Partial<Anthropic.Message> = {}) {
  const create = vi.fn(async (_body: Anthropic.MessageCreateParamsNonStreaming) => {
    return {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5-5",
      stop_reason: "tool_use",
      stop_sequence: null,
      content: [{ type: "tool_use", id: "toolu_1", name: TOOL_NAME, input: toolInput }],
      usage: {
        input_tokens: 1200,
        output_tokens: 300,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      },
      ...overrides,
    } as unknown as Anthropic.Message;
  });
  const client: AnthropicLike = { messages: { create } };
  return { client, create };
}

describe("extractMeeting", () => {
  it("keeps items with verbatim quotes and drops fabricated ones", async () => {
    const { client, create } = fakeClient({
      newItems: [
        {
          kind: "owe",
          text: "Send Nitin the final banner text",
          person: "Nitin",
          // straight quotes, extra spaces and different case still match the curly original
          quote: 'haan, main "half an hour"   mein bhej deta hoon',
          dueAt: "2026-11-25T08:51:00Z",
        },
        {
          kind: "waiting",
          text: "Push the build to staging",
          person: "Nitin",
          quote: "I'll push the build to staging by 5.",
          dueAt: "2026-11-25T11:30:00.000Z",
        },
        {
          kind: "owe",
          text: "Write release notes",
          person: "Nitin",
          quote: "Maruthi: I will write the release notes tonight",
          dueAt: null,
        },
        { kind: "decision", text: "Go with the blue banner", person: "Nitin", quote: "we go with the blue banner", dueAt: null },
      ],
      closes: [],
    });

    const result = await extractMeeting(input, { client, model: "claude-sonnet-5-5" });

    expect(result.newItems.map((i) => i.text)).toEqual([
      "Send Nitin the final banner text",
      "Push the build to staging",
      "Go with the blue banner",
    ]);
    // The stored quote is the transcript's own text, curly quotes and all.
    expect(result.newItems[0].quote).toBe("Haan, main “half an hour” mein bhej deta hoon");
    expect(result.newItems[0].dueAt).toBe("2026-11-25T08:51:00.000Z");
    // Decisions never carry a person.
    expect(result.newItems[2].person).toBeNull();
    expect(result.usage).toEqual({ inputTokens: 1200, outputTokens: 300 });

    const body = create.mock.calls[0][0];
    expect(body.model).toBe("claude-sonnet-5-5");
    expect(body.tools?.[0]).toMatchObject({ name: TOOL_NAME });
    expect(body.tool_choice).toMatchObject({ type: "auto" });
  });

  it("drops closes with unknown ids or unverifiable quotes, dedupes the rest", async () => {
    const { client } = fakeClient({
      newItems: [],
      closes: [
        { itemId: "item-1", quote: "I already shared it on Slack" },
        { itemId: "item-1", quote: "I already shared it on Slack" },
        { itemId: "item-999", quote: "I already shared it on Slack" },
        { itemId: "item-1", quote: "sent it yesterday" },
      ],
    });
    const result = await extractMeeting(input, { client, model: "m" });
    expect(result.closes).toEqual([{ itemId: "item-1", quote: "I already shared it on Slack" }]);
  });

  it("drops a close with a fabricated quote even when the id is valid", async () => {
    const { client } = fakeClient({
      newItems: [],
      closes: [{ itemId: "item-1", quote: "Got the tooltip copy, thanks" }],
    });
    const result = await extractMeeting(input, { client, model: "m" });
    expect(result.closes).toEqual([]);
  });

  it("truncates long quotes to QUOTE_MAX on a word boundary", async () => {
    const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    const { client } = fakeClient({
      newItems: [{ kind: "owe", text: "Do the long thing", person: "Nitin", quote: long, dueAt: null }],
      closes: [],
    });
    const result = await extractMeeting({ ...input, transcript: `Maruthi: ${long}` }, { client, model: "m" });
    const q = result.newItems[0].quote;
    expect(q.length).toBeLessThanOrEqual(QUOTE_MAX);
    expect(long.startsWith(q)).toBe(true);
    expect(long[q.length]).toBe(" "); // cut falls between words
  });

  it("passes Hinglish quotes through unchanged", async () => {
    const hinglish = "Maruthi: Theek hai, kal subah tak deck bhej dunga Priya ko";
    const { client } = fakeClient({
      newItems: [
        {
          kind: "owe",
          text: "Send Priya the deck",
          person: "Priya",
          quote: "kal subah tak deck bhej dunga Priya ko",
          dueAt: "2026-11-26T04:30:00Z",
        },
      ],
      closes: [],
    });
    const result = await extractMeeting({ ...input, transcript: hinglish }, { client, model: "m" });
    expect(result.newItems).toEqual([
      {
        kind: "owe",
        text: "Send Priya the deck",
        person: "Priya",
        quote: "kal subah tak deck bhej dunga Priya ko",
        dueAt: "2026-11-26T04:30:00.000Z",
      },
    ]);
  });

  it("dedupes identical items", async () => {
    const item = { kind: "owe", text: "Send Nitin the final banner text", person: "Nitin", quote: "main", dueAt: null };
    const { client } = fakeClient({ newItems: [item, { ...item, text: "send nitin the final banner text " }], closes: [] });
    const result = await extractMeeting(input, { client, model: "m" });
    expect(result.newItems).toHaveLength(1);
  });

  it("throws a clear ExtractionError when the output fails zod validation", async () => {
    const { client } = fakeClient({
      newItems: [{ kind: "promise", text: "x", person: null, quote: "main", dueAt: null }],
    });
    const err = await extractMeeting(input, { client, model: "m" }).catch((e) => e);
    expect(err).toBeInstanceOf(ExtractionError);
    expect(err.message).toMatch(/Model output failed validation/);
    expect(err.message).toMatch(/newItems\.0\.kind/);
    expect(err.message).toMatch(/closes/);
  });

  it("throws when the model does not call the tool", async () => {
    const { client } = fakeClient(null, {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Here you go", citations: null }],
    });
    await expect(extractMeeting(input, { client, model: "m" })).rejects.toThrow(/did not call/);
  });

  it("throws on max_tokens", async () => {
    const { client } = fakeClient({ newItems: [], closes: [] }, { stop_reason: "max_tokens" });
    await expect(extractMeeting(input, { client, model: "m" })).rejects.toThrow(/max_tokens/);
  });

  it("turns an unparseable dueAt into null", async () => {
    const { client } = fakeClient({
      newItems: [{ kind: "owe", text: "Send text", person: "Nitin", quote: "main", dueAt: "soon" }],
      closes: [],
    });
    const result = await extractMeeting(input, { client, model: "m" });
    expect(result.newItems[0].dueAt).toBeNull();
  });
});

describe("helpers", () => {
  it("normalize folds case, quotes and whitespace", () => {
    expect(normalize("  I’ll  “Send”\n it  ")).toBe(`i'll "send" it`);
  });

  it("truncateQuote leaves short quotes alone", () => {
    expect(truncateQuote("short")).toBe("short");
  });

  it("formats the meeting start in the user's zone", () => {
    expect(formatLocal("2026-11-25T08:21:00.000Z", "Asia/Kolkata")).toBe(
      "Wednesday 2026-11-25 13:51 (Asia/Kolkata, GMT+05:30)",
    );
  });

  it("user message lists aliases, open item ids and the transcript", () => {
    const msg = buildUserMessage(input);
    expect(msg).toContain("Also called: Maru");
    expect(msg).toContain("id=item-1");
    expect(msg).toContain("13:51");
    expect(msg).toContain(transcript);
  });

  it("costInr uses the price table", () => {
    expect(costInr("claude-sonnet-5-5", { inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(2 * USD_TO_INR);
    expect(() => costInr("unknown-model", { inputTokens: 1, outputTokens: 1 })).toThrow(/No price/);
  });
});
