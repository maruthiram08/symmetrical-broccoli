import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { fakeCreate, message, toolCall } from "../ai/fakes.test-helpers";
import { ASSIST_MAX_CHARS, ASSIST_SYSTEM_PROMPT, estimateAssist, runAssist } from "./assist";

const MODEL = "claude-sonnet-5-5";

function apiError(status: number, msg: string) {
  return new Anthropic.APIError(status, { type: "error", error: { type: "x", message: msg } }, msg, new Headers());
}

describe("writing assist (mocked Anthropic)", () => {
  it("sends only the selection, with the mode's instruction, and returns the tool's text with the cost", async () => {
    const client = fakeCreate(toolCall("write_text", { text: "Tarun will send the API spec by Friday." }));
    const r = await runAssist("translate", "Tarun bolega API spec Friday tak bhej dega", { client, model: MODEL });
    expect(r).toMatchObject({ ok: true, text: "Tarun will send the API spec by Friday.", usage: { inputTokens: 1000, outputTokens: 100 } });
    expect(r.ok && r.costInr).toBeGreaterThan(0);
    const body = client.calls[0];
    expect(body.model).toBe(MODEL);
    expect(body.system).toBe(ASSIST_SYSTEM_PROMPT);
    expect(body.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
    expect(body.tools?.[0]).toMatchObject({ name: "write_text" });
    expect(JSON.stringify(body)).not.toContain("thinking");
    const content = body.messages[0].content as string;
    expect(content).toContain("Hinglish");
    expect(content).toContain("<text>\nTarun bolega API spec Friday tak bhej dega\n</text>");
  });

  it("keeps the selection's surrounding whitespace", async () => {
    const client = fakeCreate(toolCall("write_text", { text: "Short." }));
    const r = await runAssist("shorter", "\n  A much longer sentence.\n\n", { client, model: MODEL });
    expect(r.ok && r.text).toBe("\n  Short.\n\n");
  });

  it("each mode asks for something different", async () => {
    const seen = new Set<string>();
    for (const mode of ["tidy", "shorter", "slack", "translate"] as const) {
      const client = fakeCreate(toolCall("write_text", { text: "x" }));
      await runAssist(mode, "some text", { client, model: MODEL });
      seen.add(client.calls[0].messages[0].content as string);
    }
    expect(seen.size).toBe(4);
  });

  it("takes plain text when the tool wasn't used", async () => {
    const client = fakeCreate(message([{ type: "text", text: "Hey Nitin, deck coming by Fri.", citations: null } as Anthropic.ContentBlock]));
    expect(await runAssist("slack", "send deck to nitin fri", { client, model: MODEL })).toMatchObject({ ok: true, text: "Hey Nitin, deck coming by Fri." });
  });

  it("says what to fix on key and credit errors, and never throws", async () => {
    const auth = await runAssist("tidy", "x", { client: fakeCreate(apiError(401, "invalid x-api-key")), model: MODEL });
    expect(auth).toMatchObject({ ok: false, failure: "auth" });
    expect(!auth.ok && auth.error).toMatch(/API key/);
    const credit = await runAssist("tidy", "x", { client: fakeCreate(apiError(400, "Your credit balance is too low to access the Anthropic API.")), model: MODEL });
    expect(credit).toMatchObject({ ok: false, failure: "credit" });
    const busy = await runAssist("tidy", "x", { client: fakeCreate(apiError(529, "Overloaded")), model: MODEL });
    expect(busy).toMatchObject({ ok: false, failure: "transient" });
  });

  it("refuses empty or huge selections without calling Claude", async () => {
    const client = fakeCreate();
    expect(await runAssist("tidy", "   ", { client, model: MODEL })).toMatchObject({ ok: false });
    expect(await runAssist("tidy", "a".repeat(ASSIST_MAX_CHARS + 1), { client, model: MODEL })).toMatchObject({ ok: false });
    expect(client.calls).toHaveLength(0);
  });

  it("reports refusals and cut-off answers, with what they cost", async () => {
    const r = await runAssist("tidy", "x", { client: fakeCreate(message([], { stop_reason: "refusal" as Anthropic.Message["stop_reason"] })), model: MODEL });
    expect(r).toMatchObject({ ok: false, usage: { inputTokens: 1000 } });
    const cut = await runAssist("tidy", "x", { client: fakeCreate(toolCall("write_text", { text: "par" }, { stop_reason: "max_tokens" })), model: MODEL });
    expect(cut).toMatchObject({ ok: false });
  });

  it("estimates a cost before running", () => {
    const e = estimateAssist("tidy", "a".repeat(400), MODEL);
    expect(e.inputTokens).toBeGreaterThan(100);
    expect(e.costInr).toBeGreaterThan(0);
    expect(estimateAssist("tidy", "x", "unknown-model").costInr).toBeNull();
  });
});
