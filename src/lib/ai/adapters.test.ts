// Every provider adapter with a fake SDK client or fake fetch. Nothing here touches the network.
import { describe, expect, it, vi } from "vitest";
import { adapt, geminiBackend, jsonSystem, mistralBackend, ollamaBackend, openAiBackend, openRouterBackend, type FetchFn } from "./adapters";
import { classifyProviderError, failureMessage } from "./errors";
import { parseJsonObject, strictSchema, withoutAdditional } from "./schema";
import { extractMeeting, OUTPUT_JSON_SCHEMA } from "../extract/extract";
import { SYSTEM_PROMPT, TOOL_NAME } from "../extract/prompt";
import { AnthropicCallError } from "../extract/errors";
import { streamAnswer } from "../ask/ask";
import { runAssist } from "../editor/assist";
import type { ExtractionInput } from "../types";

const transcript = "Maruthi: I'll send Nitin the banner copy by Friday.\nNitin: Great, thanks.";
const input: ExtractionInput = {
  transcript,
  user: { name: "Maruthi", aliases: [], timeZone: "Asia/Kolkata" },
  meeting: { title: "Banner sync", startedAt: "2026-11-24T06:00:00Z", participants: ["Nitin"] },
  openItems: [],
};
const output = {
  newItems: [
    { kind: "owe", text: "Send Nitin the banner copy", person: "Nitin", quote: "I'll send Nitin the banner copy by Friday", dueAt: null, attribution: null },
    { kind: "owe", text: "Invented", person: null, quote: "this was never said", dueAt: null, attribution: null },
  ],
  closes: [],
};

/** A fake OpenAI / Groq client: records requests, answers in order. */
function fakeOpenAi(...replies: unknown[]) {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    chat: { completions: { create: vi.fn(async (body: Record<string, unknown>) => {
      calls.push(body);
      const r = replies.shift();
      if (r instanceof Error) throw r;
      return r;
    }) } },
  };
}

describe("schemas", () => {
  it("makes a strict schema: every property required, optional ones nullable", () => {
    const s = strictSchema(OUTPUT_JSON_SCHEMA as Record<string, unknown>) as { properties: { newItems: { items: { required: string[]; properties: { attribution: { type: unknown; enum: unknown[] } } } } } };
    const item = s.properties.newItems.items;
    expect(item.required).toContain("attribution");
    expect(item.properties.attribution.type).toEqual(["string", "null"]);
    expect(item.properties.attribution.enum).toContain(null);
    expect(JSON.stringify(withoutAdditional(OUTPUT_JSON_SCHEMA as Record<string, unknown>))).not.toContain("additionalProperties");
  });
  it("reads a JSON object from text, with or without a fence", () => {
    expect(parseJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonObject("no")).toBeNull();
    expect(parseJsonObject("[1]")).toBeNull();
  });
  it("swaps the tool line for a JSON instruction", () => {
    const s = jsonSystem(SYSTEM_PROMPT, { name: TOOL_NAME, input_schema: { type: "object" } });
    expect(s).not.toContain("by calling the");
    expect(s).toContain(`input of the ${TOOL_NAME} tool`);
  });
});

describe("OpenAI-style adapter", () => {
  it("extraction in tool mode: forced function, same schema, quote check drops invented quotes", async () => {
    const client = fakeOpenAi({ choices: [{ message: { content: null, tool_calls: [{ function: { name: TOOL_NAME, arguments: JSON.stringify(output) } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 900, completion_tokens: 80 } });
    const ai = adapt("groq", openAiBackend(client), "tool");
    const r = await extractMeeting(input, { client: ai, model: "groq:some-model" });
    const body = client.calls[0];
    expect(body.model).toBe("some-model");
    expect(body.tool_choice).toEqual({ type: "function", function: { name: TOOL_NAME } });
    expect((body.tools as Array<{ function: { parameters: unknown } }>)[0].function.parameters).toEqual(OUTPUT_JSON_SCHEMA);
    expect((body.messages as Array<{ role: string; content: string }>)[0]).toMatchObject({ role: "system", content: SYSTEM_PROMPT });
    expect(r.newItems.map((i) => i.text)).toEqual(["Send Nitin the banner copy"]);
    expect(r.usage).toEqual({ inputTokens: 900, outputTokens: 80 });
  });

  it("extraction in json_schema mode: strict response format and a JSON system prompt", async () => {
    const client = fakeOpenAi({ choices: [{ message: { content: JSON.stringify(output) }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    const ai = adapt("openai", openAiBackend(client, { maxTokensField: "max_completion_tokens" }), "json_schema");
    const r = await extractMeeting(input, { client: ai, model: "openai:m" });
    const body = client.calls[0] as { response_format: { type: string; json_schema: { strict: boolean; name: string } }; max_completion_tokens: number; tools?: unknown; messages: Array<{ content: string }> };
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema).toMatchObject({ name: TOOL_NAME, strict: true });
    expect(body.max_completion_tokens).toBe(8000);
    expect(body.tools).toBeUndefined();
    expect(body.messages[0].content).toContain("Answer with one JSON object");
    expect(r.newItems).toHaveLength(1);
  });

  it("a cut-off answer is max_tokens, a refusal is a refusal", async () => {
    const cut = adapt("xai", openAiBackend(fakeOpenAi({ choices: [{ message: { content: "{" }, finish_reason: "length" }] })), "json_schema");
    await expect(extractMeeting(input, { client: cut, model: "xai:m" })).rejects.toThrow(/max_tokens/);
    const no = adapt("openai", openAiBackend(fakeOpenAi({ choices: [{ message: { content: null, refusal: "no" }, finish_reason: "stop" }] })), "json_schema");
    await expect(extractMeeting(input, { client: no, model: "openai:m" })).rejects.toThrow(/refusal/);
  });

  it("errors are classified like Anthropic's, and retried only when transient", async () => {
    const e401 = Object.assign(new Error("bad key"), { status: 401 });
    const auth = adapt("openai", openAiBackend(fakeOpenAi(e401)), "tool");
    await expect(extractMeeting(input, { client: auth, model: "openai:m", retry: { sleep: async () => {} } })).rejects.toMatchObject({ kind: "auth" });
    const busy = fakeOpenAi(Object.assign(new Error("slow down"), { status: 429 }), { choices: [{ message: { content: JSON.stringify(output) }, finish_reason: "stop" }] });
    const r = await extractMeeting(input, { client: adapt("openai", openAiBackend(busy), "json_schema"), model: "openai:m", retry: { sleep: async () => {} } });
    expect(busy.calls).toHaveLength(2);
    expect(r.newItems).toHaveLength(1);
  });

  it("streams Ask answers and reports usage", async () => {
    async function* chunks() {
      yield { choices: [{ delta: { content: "You owe Nitin " } }] };
      yield { choices: [{ delta: { content: "the copy [1]." }, finish_reason: "stop" }] };
      yield { choices: [], usage: { prompt_tokens: 300, completion_tokens: 12 } };
    }
    const client = fakeOpenAi(chunks());
    const ai = adapt("openai", openAiBackend(client, { streamUsage: true }), "tool");
    const src = { n: 1, itemId: "i1", kind: "owe" as const, status: "open" as const, text: "Send Nitin the copy", person: "Nitin", quote: "q", closeQuote: null, dueAt: null, meetingTitle: "Sync", at: "2026-11-24T06:00:00Z" };
    const evs = [];
    for await (const e of streamAnswer({ question: "what do I owe?", sources: [src], userName: "M", timeZone: "UTC", now: new Date("2026-11-25T00:00:00Z"), history: [{ question: "earlier?", answer: "Yes [2]." }] }, { client: ai, model: "openai:m", who: { account: "OpenAI", model: "OpenAI" } })) evs.push(e);
    expect(evs.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("")).toBe("You owe Nitin the copy [1].");
    expect(evs.at(-1)).toMatchObject({ type: "done", usage: { inputTokens: 300, outputTokens: 12 } });
    const body = client.calls[0] as { stream: boolean; stream_options: unknown; messages: Array<{ role: string; content: string }> };
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    // History goes first, citations dropped.
    expect(body.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(body.messages[2].content).toBe("Yes.");
  });

  it("Ask errors name the provider", async () => {
    const ai = adapt("deepseek", openAiBackend(fakeOpenAi(Object.assign(new Error("x"), { status: 402 }))), "tool");
    const src = { n: 1, itemId: "i1", kind: "owe" as const, status: "open" as const, text: "t", person: null, quote: "q", closeQuote: null, dueAt: null, meetingTitle: "m", at: "2026-11-24T06:00:00Z" };
    const evs = [];
    for await (const e of streamAnswer({ question: "q", sources: [src], userName: "M", timeZone: "UTC", now: new Date() }, { client: ai, model: "deepseek:m", who: { account: "DeepSeek", model: "DeepSeek" } })) evs.push(e);
    expect(evs.at(-1)).toMatchObject({ type: "error", failure: "credit", error: "Your DeepSeek account is out of credit. Add credit, then ask again." });
  });

  it("writing assist works through the adapter (tool call)", async () => {
    const client = fakeOpenAi({ choices: [{ message: { tool_calls: [{ function: { name: "write_text", arguments: '{"text":"Tidy text."}' } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    const r = await runAssist("tidy", "tidy txt", { client: adapt("compatible", openAiBackend(client), "tool"), model: "compatible:local" });
    expect(r).toMatchObject({ ok: true, text: "Tidy text." });
  });
});

describe("Gemini adapter", () => {
  it("sends responseJsonSchema and the system instruction, reads JSON text back", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- typed so mock.calls has the body
    const generateContent = vi.fn(async (_p: unknown) => ({ text: JSON.stringify(output), candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 50, thoughtsTokenCount: 20 } }));
    const ai = adapt("gemini", geminiBackend({ models: { generateContent, generateContentStream: vi.fn() } }), "json_schema");
    const r = await extractMeeting(input, { client: ai, model: "gemini:g-model" });
    const p = generateContent.mock.calls[0][0] as { model: string; config: { responseMimeType: string; responseJsonSchema: unknown; systemInstruction: string; maxOutputTokens: number } };
    expect(p.model).toBe("g-model");
    expect(p.config.responseMimeType).toBe("application/json");
    expect(JSON.stringify(p.config.responseJsonSchema)).not.toContain("additionalProperties");
    expect(p.config.systemInstruction).toContain("Answer with one JSON object");
    expect(r.newItems).toHaveLength(1);
    expect(r.usage).toEqual({ inputTokens: 500, outputTokens: 70 });
  });
  it("streams text", async () => {
    async function* s() { yield { text: "Hel" }; yield { text: "lo", usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } }; }
    const ai = adapt("gemini", geminiBackend({ models: { generateContent: vi.fn(), generateContentStream: vi.fn(async () => s()) } }), "json_schema");
    const st = ai.messages.stream({ model: "gemini:g", max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
    let t = "";
    for await (const e of st) if (e.type === "content_block_delta" && e.delta.type === "text_delta") t += e.delta.text;
    expect(t).toBe("Hello");
    expect((await st.finalMessage()).usage.input_tokens).toBe(3);
  });
});

describe("Mistral and OpenRouter adapters", () => {
  it("Mistral: camelCase json_schema with schemaDefinition, object arguments are fine too", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- typed so mock.calls has the body
    const complete = vi.fn(async (_r: unknown) => ({ choices: [{ message: { content: JSON.stringify(output) }, finishReason: "stop" }], usage: { promptTokens: 7, completionTokens: 3 } }));
    const ai = adapt("mistral", mistralBackend({ chat: { complete, stream: vi.fn() } }), "json_schema");
    const r = await extractMeeting(input, { client: ai, model: "mistral:mm" });
    const req = complete.mock.calls[0][0] as { model: string; maxTokens: number; responseFormat: { type: string; jsonSchema: { schemaDefinition: unknown; strict: boolean } } };
    expect(req).toMatchObject({ model: "mm", maxTokens: 8000 });
    expect(req.responseFormat.jsonSchema.schemaDefinition).toBeTruthy();
    expect(r.newItems).toHaveLength(1);

    const tool = vi.fn(async () => ({ choices: [{ message: { toolCalls: [{ function: { name: TOOL_NAME, arguments: output } }] }, finishReason: "tool_calls" }], usage: {} }));
    const r2 = await extractMeeting(input, { client: adapt("mistral", mistralBackend({ chat: { complete: tool, stream: vi.fn() } }), "tool"), model: "mistral:mm" });
    expect(r2.newItems).toHaveLength(1);
  });
  it("Mistral's statusCode errors are classified too", async () => {
    const complete = vi.fn(async () => { throw Object.assign(new Error("Unauthorized"), { statusCode: 401 }); });
    const ai = adapt("mistral", mistralBackend({ chat: { complete, stream: vi.fn() } }), "tool");
    await expect(ai.messages.create({ model: "mistral:m", max_tokens: 5, messages: [{ role: "user", content: "x" }] })).rejects.toMatchObject({ kind: "auth" });
  });
  it("OpenRouter: chatRequest with a forced tool, and streaming", async () => {
    const send = vi.fn(async (req: { chatRequest: { stream: boolean } }) => {
      if (req.chatRequest.stream) return (async function* () { yield { choices: [{ delta: { content: "ok" } }] }; yield { choices: [], usage: { promptTokens: 4, completionTokens: 1 } }; })();
      return { choices: [{ message: { toolCalls: [{ function: { name: TOOL_NAME, arguments: JSON.stringify(output) } }] }, finishReason: "tool_calls" }], usage: { promptTokens: 2, completionTokens: 1 } };
    });
    const ai = adapt("openrouter", openRouterBackend({ chat: { send } }), "tool");
    const r = await extractMeeting(input, { client: ai, model: "openrouter:vendor/model:free" });
    const first = send.mock.calls[0][0] as unknown as { chatRequest: { model: string; toolChoice: unknown } };
    expect(first.chatRequest.model).toBe("vendor/model:free");
    expect(first.chatRequest.toolChoice).toEqual({ type: "function", function: { name: TOOL_NAME } });
    expect(r.newItems).toHaveLength(1);
    const st = ai.messages.stream({ model: "openrouter:x", max_tokens: 5, messages: [{ role: "user", content: "hi" }] });
    let t = "";
    for await (const e of st) if (e.type === "content_block_delta" && e.delta.type === "text_delta") t += e.delta.text;
    expect(t).toBe("ok");
    expect((await st.finalMessage()).usage.output_tokens).toBe(1);
  });
});

describe("Ollama adapter (fetch)", () => {
  it("sends format = schema for structured output and streams NDJSON", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetch: FetchFn = async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url, body });
      if (body.stream) {
        const text = '{"message":{"content":"Hi "},"done":false}\n{"message":{"content":"there"},"done":true,"prompt_eval_count":9,"eval_count":2}\n';
        return { ok: true, status: 200, json: async () => ({}), text: async () => text, body: null };
      }
      return { ok: true, status: 200, json: async () => ({ message: { content: JSON.stringify(output) }, prompt_eval_count: 5, eval_count: 2 }), text: async () => "" };
    };
    const ai = adapt("ollama", ollamaBackend("http://127.0.0.1:11434/", fetch), "json_schema");
    const r = await extractMeeting(input, { client: ai, model: "ollama:qwen2.5:14b" });
    expect(calls[0].url).toBe("http://127.0.0.1:11434/api/chat");
    expect(calls[0].body.model).toBe("qwen2.5:14b");
    expect(calls[0].body.format).toEqual(OUTPUT_JSON_SCHEMA);
    expect(r.newItems).toHaveLength(1);
    const st = ai.messages.stream({ model: "ollama:m", max_tokens: 5, messages: [{ role: "user", content: "hi" }] });
    let t = "";
    for await (const e of st) if (e.type === "content_block_delta" && e.delta.type === "text_delta") t += e.delta.text;
    expect(t).toBe("Hi there");
    expect((await st.finalMessage()).usage).toMatchObject({ input_tokens: 9, output_tokens: 2 });
  });
  it("Ollama not running is a transient failure", async () => {
    const fetch: FetchFn = async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); };
    const ai = adapt("ollama", ollamaBackend("http://127.0.0.1:11434", fetch), "json_schema");
    await expect(ai.messages.create({ model: "ollama:m", max_tokens: 5, messages: [{ role: "user", content: "x" }] })).rejects.toBeInstanceOf(AnthropicCallError);
  });
});

describe("error classification", () => {
  it("maps credit, auth and transient across providers", () => {
    expect(classifyProviderError({ status: 402 })).toBe("credit");
    expect(classifyProviderError({ status: 429, error: { code: "insufficient_quota" }, message: "You exceeded your current quota" })).toBe("credit");
    expect(classifyProviderError({ status: 429, message: "Rate limit" })).toBe("transient");
    expect(classifyProviderError({ statusCode: 401 })).toBe("auth");
    expect(classifyProviderError({ status: 400, message: "API key not valid. Please pass a valid API key." })).toBe("auth");
    expect(classifyProviderError({ status: 503 })).toBe("transient");
    expect(classifyProviderError({ status: 404 })).toBe("bad_request");
    expect(classifyProviderError(Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }))).toBe("offline");
  });
  it("keeps Anthropic's wording by default", () => {
    expect(failureMessage("auth")).toBe("Your Anthropic API key was rejected. Check it in Settings.");
    expect(failureMessage("transient", { account: "Groq", model: "Groq" })).toBe("Groq is busy right now. Try again in a minute.");
  });
});
