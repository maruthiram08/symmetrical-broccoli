import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { AnthropicCallError, classifyAnthropicError, isNetworkError, withAnthropicRetry } from "./errors";
import { extractMeeting, type AnthropicLike } from "./extract";
import { TOOL_NAME } from "./prompt";

/** Shaped like the SDK's APIError subclasses (status, error body, headers). */
const apiError = (status: number, message: string, name = "APIError", headers: Record<string, string> = {}) =>
  Object.assign(new Error(`${status} ${message}`), { name, status, error: { type: "error", error: { message } }, headers: new Headers(headers) });

const credit = () => apiError(400, "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.", "BadRequestError");

describe("classifyAnthropicError", () => {
  it("tells key, credit, transient and offline problems apart", () => {
    expect(classifyAnthropicError(apiError(401, "invalid x-api-key", "AuthenticationError"))).toBe("auth");
    expect(classifyAnthropicError(apiError(403, "permission", "PermissionDeniedError"))).toBe("auth");
    expect(classifyAnthropicError(credit())).toBe("credit");
    expect(classifyAnthropicError(apiError(400, "messages: field required", "BadRequestError"))).toBe("bad_request");
    expect(classifyAnthropicError(apiError(429, "rate_limit_error", "RateLimitError"))).toBe("transient");
    expect(classifyAnthropicError(apiError(529, "overloaded_error", "InternalServerError"))).toBe("transient");
    expect(classifyAnthropicError(apiError(500, "api_error", "InternalServerError"))).toBe("transient");
    expect(classifyAnthropicError(Object.assign(new Error("Request timed out."), { name: "APIConnectionTimeoutError" }))).toBe("transient");
    const offline = Object.assign(new Error("Connection error."), { name: "APIConnectionError", cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }) });
    expect(classifyAnthropicError(offline)).toBe("offline");
    expect(isNetworkError(new TypeError("fetch failed"))).toBe(true);
    expect(isNetworkError(apiError(500, "x"))).toBe(false);
  });
});

describe("withAnthropicRetry", () => {
  it("retries overload and rate limits with growing waits, honouring retry-after", async () => {
    const waits: number[] = [];
    let n = 0;
    const r = await withAnthropicRetry(async () => {
      n++;
      if (n === 1) throw apiError(529, "overloaded_error");
      if (n === 2) throw apiError(429, "rate_limit_error", "RateLimitError", { "retry-after": "7" });
      return "ok";
    }, { sleep: async (ms) => { waits.push(ms); }, baseMs: 1000 });
    expect(r).toBe("ok");
    expect(n).toBe(3);
    expect(waits[0]).toBeGreaterThanOrEqual(750);
    expect(waits[0]).toBeLessThanOrEqual(1250);
    expect(waits[1]).toBe(7000);
  });

  it("gives up after the retries with a transient AnthropicCallError", async () => {
    let n = 0;
    const err = await withAnthropicRetry(async () => { n++; throw apiError(529, "overloaded_error"); }, { retries: 2, sleep: async () => {} }).catch((e) => e);
    expect(n).toBe(3);
    expect(err).toBeInstanceOf(AnthropicCallError);
    expect(err).toMatchObject({ kind: "transient", status: 529 });
  });

  it("does not retry a bad key or an empty account", async () => {
    for (const [e, kind] of [[apiError(401, "invalid x-api-key"), "auth"], [credit(), "credit"]] as const) {
      let n = 0;
      const err = await withAnthropicRetry(async () => { n++; throw e; }, { sleep: async () => {} }).catch((x) => x);
      expect(n).toBe(1);
      expect(err).toMatchObject({ name: "AnthropicCallError", kind });
      expect(err.message).not.toContain("credit balance"); // our message, never the response body
    }
  });
});

describe("extractMeeting errors", () => {
  const input = {
    transcript: "Maruthi: I'll send it.",
    user: { name: "Maruthi", aliases: [], timeZone: "Asia/Kolkata" },
    meeting: { title: "T", startedAt: "2026-11-25T08:00:00.000Z", participants: [] },
    openItems: [],
  };
  it("turns a rejected key into an auth AnthropicCallError without retrying", async () => {
    let calls = 0;
    const client: AnthropicLike = { messages: { create: async () => { calls++; throw apiError(401, "invalid x-api-key", "AuthenticationError"); } } };
    await expect(extractMeeting(input, { client, model: "m", retry: { sleep: async () => {} } })).rejects.toMatchObject({ kind: "auth" });
    expect(calls).toBe(1);
  });
  it("retries a timeout and then succeeds", async () => {
    let calls = 0;
    const ok = { content: [{ type: "tool_use", id: "t", name: TOOL_NAME, input: { newItems: [], closes: [] } }], stop_reason: "tool_use", usage: { input_tokens: 5, output_tokens: 1 } } as unknown as Anthropic.Message;
    const client: AnthropicLike = {
      messages: { create: async () => { calls++; if (calls === 1) throw Object.assign(new Error("Request timed out."), { name: "APIConnectionTimeoutError" }); return ok; } },
    };
    const r = await extractMeeting(input, { client, model: "m", retry: { sleep: async () => {} } });
    expect(calls).toBe(2);
    expect(r).toMatchObject({ newItems: [], closes: [], usage: { inputTokens: 5, outputTokens: 1 } });
  });
});
