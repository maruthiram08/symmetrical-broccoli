import { describe, expect, it, vi } from "vitest";
import type { ExtractionInput } from "../types";
import { AnthropicCallError } from "./errors";
import { OUTPUT_JSON_SCHEMA } from "./extract";
import { checkOllama, extractMeetingOllama, OLLAMA_SYSTEM_PROMPT, type FetchLike } from "./ollama";
import { SYSTEM_PROMPT, TOOL_NAME } from "./prompt";

const input: ExtractionInput = {
  transcript: "Maruthi: I'll send the deck to Nitin by tomorrow.\nNitin: Great. The venue is booked, done.",
  user: { name: "Maruthi", aliases: [], timeZone: "Asia/Kolkata" },
  meeting: { title: "Sync", startedAt: "2026-11-26T05:00:00.000Z", participants: ["Nitin"] },
  openItems: [{ id: "it1", kind: "waiting", text: "Book the venue", person: "Nitin" }],
};

function ollama(reply: unknown, status = 200) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const f: FetchLike = vi.fn(async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: status < 400, status, json: async () => reply, text: async () => "" };
  });
  return { f, calls };
}

describe("on-device extraction with Ollama", () => {
  it("uses the same prompt and schema, in JSON mode, and post-processes like Claude", async () => {
    const content = JSON.stringify({
      newItems: [
        { kind: "owe", text: "Send Nitin the deck", person: "Nitin", quote: "I'll send the deck to Nitin by tomorrow.", dueAt: "2026-11-27T04:30:00Z" },
        { kind: "owe", text: "Made up", person: null, quote: "this was never said", dueAt: null },
      ],
      closes: [{ itemId: "it1", quote: "The venue is booked, done." }, { itemId: "nope", quote: "done" }],
    });
    const { f, calls } = ollama({ message: { content }, prompt_eval_count: 900, eval_count: 120, done_reason: "stop" });
    const r = await extractMeetingOllama(input, { url: "http://127.0.0.1:11434/", model: "qwen2.5:14b", fetch: f });
    expect(calls[0].url).toBe("http://127.0.0.1:11434/api/chat");
    expect(calls[0].body).toMatchObject({ model: "qwen2.5:14b", stream: false, format: OUTPUT_JSON_SCHEMA, options: { temperature: 0 } });
    const msgs = calls[0].body.messages as Array<{ role: string; content: string }>;
    expect(msgs[0].content).toBe(OLLAMA_SYSTEM_PROMPT);
    expect(msgs[1].content).toContain("<transcript>");
    expect(r.newItems.map((i) => i.text)).toEqual(["Send Nitin the deck"]); // invented quote dropped
    expect(r.closes).toEqual([{ itemId: "it1", quote: "The venue is booked, done." }]);
    expect(r.usage).toEqual({ inputTokens: 900, outputTokens: 120 });
  });

  it("asks for JSON instead of a tool call, keeping the rest of the prompt", () => {
    expect(OLLAMA_SYSTEM_PROMPT).not.toBe(SYSTEM_PROMPT);
    expect(OLLAMA_SYSTEM_PROMPT).not.toContain("Do not answer in plain text");
    expect(OLLAMA_SYSTEM_PROMPT).toContain(`input of the ${TOOL_NAME} tool`);
    expect(OLLAMA_SYSTEM_PROMPT).toContain("Closing the user's open items");
  });

  it("explains a missing model, retries later when Ollama is down or failing, and rejects bad output", async () => {
    await expect(extractMeetingOllama(input, { url: "http://x", model: "m", fetch: ollama({}, 404).f })).rejects.toThrow(/ollama pull m/);
    await expect(extractMeetingOllama(input, { url: "http://x", model: "m", fetch: ollama({}, 500).f })).rejects.toMatchObject({ kind: "transient" });
    const down: FetchLike = async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); };
    const e = await extractMeetingOllama(input, { url: "http://x", model: "m", fetch: down }).catch((x) => x);
    expect(e).toBeInstanceOf(AnthropicCallError);
    expect(e.kind).toBe("transient"); // never "auth": a local model must not raise the API-key banner
    await expect(extractMeetingOllama(input, { url: "http://x", model: "m", fetch: ollama({ message: { content: "not json" } }).f })).rejects.toThrow(/didn't answer with JSON/);
    await expect(extractMeetingOllama(input, { url: "http://x", model: "m", fetch: ollama({ message: { content: '{"newItems":[]}' } }).f })).rejects.toThrow(/failed validation/);
    await expect(extractMeetingOllama(input, { url: "http://x", model: "m", fetch: ollama({ message: { content: "{" }, done_reason: "length" }).f })).rejects.toThrow(/ran out of room/);
  });

  it("checks that Ollama runs and has the model", async () => {
    const tags = (names: string[]): FetchLike => async () => ({ ok: true, status: 200, json: async () => ({ models: names.map((name) => ({ name })) }), text: async () => "" });
    expect(await checkOllama("http://x", "llama3.1", tags(["llama3.1:latest"]))).toMatchObject({ ok: true });
    expect(await checkOllama("http://x", "qwen2.5:14b", tags(["llama3.1:latest"]))).toMatchObject({ ok: false, message: expect.stringMatching(/ollama pull qwen2.5:14b/) });
    expect(await checkOllama("http://x", "m", async () => { throw new Error("down"); })).toMatchObject({ ok: false, message: expect.stringMatching(/Couldn't reach/) });
  });
});
