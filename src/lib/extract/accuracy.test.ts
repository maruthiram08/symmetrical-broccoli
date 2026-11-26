// Attribution under wrong speaker labels, and decision stability (explicit agreement, fixed wording,
// no repeats of earlier decisions). All model calls are faked.
import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type { ExtractionInput } from "../types";
import { MemoryStore } from "@/server/store";
import { MAX_OPEN_DECISIONS, processMeeting } from "@/server/jobs/process";
import { extractMeeting, OUTPUT_JSON_SCHEMA, sameDecision, type AnthropicLike, type PostProcessReport } from "./extract";
import { SYSTEM_PROMPT, TOOL_NAME, buildUserMessage } from "./prompt";
import { OLLAMA_SYSTEM_PROMPT } from "./ollama";
import { costInr, costInrWithCache, USD_TO_INR } from "./cost";

// Wispr put Ravi's answer under the user's label.
const transcript = `Maruthi: Ravi, can you send me the API spec by tomorrow?
Maruthi: Haan, main kal bhej dunga.
Ravi: Ok so final, we go with one alert flow for web and mobile.
Maruthi: Agreed.`;

const input: ExtractionInput = {
  transcript,
  user: { name: "Maruthi", aliases: [], timeZone: "Asia/Kolkata" },
  meeting: { title: "Alerts", startedAt: "2026-11-25T08:00:00.000Z", participants: ["Maruthi", "Ravi"] },
  openItems: [],
};

function fake(toolInput: unknown, usage: Partial<Anthropic.Usage> = {}) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const create = vi.fn(async (_body: Anthropic.MessageCreateParamsNonStreaming) => ({
    id: "msg", type: "message", role: "assistant", model: "claude-sonnet-5-5", stop_reason: "tool_use", stop_sequence: null,
    content: [{ type: "tool_use", id: "t", name: TOOL_NAME, input: toolInput }],
    usage: { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: null, cache_read_input_tokens: null, ...usage },
  }) as unknown as Anthropic.Message);
  const client: AnthropicLike = { messages: { create } };
  return { client, create };
}

const waiting = { kind: "waiting", text: "Send the API spec", person: "Ravi", quote: "Haan, main kal bhej dunga.", dueAt: null };
const decision = { kind: "decision", text: "Use one alert flow for web and mobile", person: null, quote: "we go with one alert flow for web and mobile", dueAt: null };

describe("prompt", () => {
  it("tells the model how to attribute promises when labels are wrong", () => {
    expect(SYSTEM_PROMPT).toContain("Who made each promise");
    expect(SYSTEM_PROMPT).toMatch(/Who is addressed/);
    expect(SYSTEM_PROMPT).toMatch(/"I'll do it"/);
    expect(SYSTEM_PROMPT).toMatch(/reply chain/i);
    expect(SYSTEM_PROMPT).toMatch(/Usual roles, only to break a tie/);
    expect(SYSTEM_PROMPT).toMatch(/prefer the person the content points to/);
    expect(SYSTEM_PROMPT).toMatch(/Never invent a person/);
  });

  it("asks for an explicit agreement signal and one wording shape for decisions", () => {
    expect(SYSTEM_PROMPT).toMatch(/explicit agreement signal/);
    expect(SYSTEM_PROMPT).toMatch(/If you are not sure the agreement was explicit, leave it out/);
    expect(SYSTEM_PROMPT).toMatch(/one fixed shape/);
    expect(SYSTEM_PROMPT).toContain("Decisions already recorded");
    expect(SYSTEM_PROMPT).toMatch(/a deadline, scope or design for the team's work stated as settled/);
  });

  it("treats closing as its own pass, independent of the attribution and decision rules", () => {
    expect(SYSTEM_PROMPT).toContain("Closing the user's open items (a separate pass)");
    expect(SYSTEM_PROMPT).toMatch(/Go through them one by one, by id/);
    expect(SYSTEM_PROMPT).toMatch(/do not apply here/);
    expect(SYSTEM_PROMPT).toMatch(/counts whatever label it carries/);
    // the closing section stays last, after the new-item rules
    expect(SYSTEM_PROMPT.indexOf("Closing the user's open items")).toBeGreaterThan(SYSTEM_PROMPT.indexOf("Decisions already recorded"));
  });

  it("the Ollama prompt keeps the new rules", () => {
    expect(OLLAMA_SYSTEM_PROMPT).toContain("Who made each promise");
    expect(OLLAMA_SYSTEM_PROMPT).toContain('"attribution"');
  });

  it("lists earlier decisions in the request only when there are some", () => {
    const msg = buildUserMessage({ ...input, openDecisions: [{ text: "Ship the banner without the tooltip" }] });
    expect(msg).toContain("Decisions already recorded in earlier meetings:\n- Ship the banner without the tooltip\n\n<transcript>");
    const plain = buildUserMessage(input);
    expect(plain).not.toContain("Decisions already recorded");
    expect(plain).toContain("(none)\n\n<transcript>");
  });
});

describe("attribution field", () => {
  it("is optional in the tool schema, so older answers still validate", () => {
    const item = (OUTPUT_JSON_SCHEMA.properties as Record<string, { items: { required: string[]; properties: Record<string, unknown> } }>).newItems.items;
    expect(item.properties.attribution).toMatchObject({ enum: ["label", "content"] });
    expect(item.required).not.toContain("attribution");
  });

  it("passes through on owe/waiting, is dropped on decisions, and may be missing or null", async () => {
    const { client } = fake({
      newItems: [
        { ...waiting, attribution: "content" },
        { ...decision, attribution: "label" },
        { kind: "owe", text: "Review the alert copy", person: "Ravi", quote: "Agreed.", dueAt: null, attribution: null },
      ],
      closes: [],
    });
    const r = await extractMeeting(input, { client, model: "m" });
    expect(r.newItems[0]).toMatchObject({ kind: "waiting", person: "Ravi", attribution: "content" });
    expect(r.newItems[1]).not.toHaveProperty("attribution");
    expect(r.newItems[2]).not.toHaveProperty("attribution");
  });

  it("rejects an unknown attribution value", async () => {
    const { client } = fake({ newItems: [{ ...waiting, attribution: "guess" }], closes: [] });
    await expect(extractMeeting(input, { client, model: "m" })).rejects.toThrow(/validation/);
  });
});

describe("decision repeats", () => {
  it("sameDecision catches rewordings but lets changed decisions through", () => {
    expect(sameDecision("Use one alert flow for web and mobile", "use one alert flow for web and mobile.")).toBe(true);
    expect(sameDecision("Use one alert flow for web and mobile", "Use one alert flow for mobile and web")).toBe(true);
    expect(sameDecision("Keep the alerts flow for web and mobile", "We will keep the alert flow for web and mobile")).toBe(true);
    expect(sameDecision("Show the banner on web only", "Show the banner on web and mobile")).toBe(false);
    expect(sameDecision("Ship the banner without the tooltip", "Ship the banner with the tooltip")).toBe(false);
    expect(sameDecision("Ship it", "Skip it")).toBe(false);
  });

  it("drops a decision that repeats an earlier open decision, and near-duplicates within one read", async () => {
    const { client } = fake({
      newItems: [decision, { ...decision, text: "Use one alert flow for mobile and web" }, { ...decision, text: "Skip the referral banner this release", quote: "Agreed." }],
      closes: [],
    });
    const report: PostProcessReport = { droppedItems: [], droppedCloses: [] };
    const r = await extractMeeting({ ...input, openDecisions: [{ text: "Skip the referral banner this release" }] }, { client, model: "m", report });
    expect(r.newItems.map((i) => i.text)).toEqual(["Use one alert flow for web and mobile"]);
    expect(report.droppedItems.map((d) => d.reason)).toEqual(["duplicate", "repeats an earlier decision"]);
  });

  it("does not dedupe owe/waiting items against earlier decisions", async () => {
    const { client } = fake({ newItems: [{ ...waiting, text: "Use one alert flow for web and mobile" }], closes: [] });
    const r = await extractMeeting({ ...input, openDecisions: [{ text: "Use one alert flow for web and mobile" }] }, { client, model: "m" });
    expect(r.newItems).toHaveLength(1);
  });
});

describe("request", () => {
  it("sends no sampling parameters (claude-sonnet-5-5 rejects them)", async () => {
    const { client, create } = fake({ newItems: [], closes: [] });
    await extractMeeting(input, { client, model: "claude-sonnet-5-5" });
    const body = create.mock.calls[0][0] as unknown as Record<string, unknown>;
    for (const k of ["temperature", "top_p", "top_k"]) expect(body).not.toHaveProperty(k);
    expect(body.messages).toEqual([{ role: "user", content: buildUserMessage(input) }]);
    expect(body.system).toBe(SYSTEM_PROMPT);
  });

  it("eval options: another system prompt, a cached request, and the cache tokens in the report", async () => {
    const { client, create } = fake({ newItems: [], closes: [] }, { cache_read_input_tokens: 900, cache_creation_input_tokens: 0, input_tokens: 100 });
    const report: PostProcessReport = { droppedItems: [], droppedCloses: [] };
    const r = await extractMeeting(input, { client, model: "m", system: "OTHER", cacheRequest: true, report });
    const body = create.mock.calls[0][0];
    expect(body.system).toBe("OTHER");
    expect(body.messages[0].content).toEqual([{ type: "text", text: buildUserMessage(input), cache_control: { type: "ephemeral" } }]);
    expect(report.cache).toEqual({ readTokens: 900, writeTokens: 0 });
    expect(r.usage.inputTokens).toBe(1000);
  });

  it("prices cache reads and writes", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 0 };
    expect(costInrWithCache("claude-sonnet-5-5", usage, { readTokens: 0, writeTokens: 0 })).toBeCloseTo(costInr("claude-sonnet-5-5", usage));
    expect(costInrWithCache("claude-sonnet-5-5", usage, { readTokens: 1_000_000, writeTokens: 0 })).toBeCloseTo(0.1 * USD_TO_INR);
    expect(costInrWithCache("claude-sonnet-5-5", usage, { readTokens: 0, writeTokens: 1_000_000 })).toBeCloseTo(2.5 * USD_TO_INR);
    expect(costInrWithCache("claude-opus-5-5", usage, { readTokens: 1_000_000, writeTokens: 0 })).toBeCloseTo(0.4 * USD_TO_INR);
  });
});

describe("processMeeting", () => {
  it("sends earlier open decisions as context, not as open items", async () => {
    const s = new MemoryStore();
    const u = s.addUser({ email: "a@b", name: "Me" });
    await s.saveConnection({ userId: u.id, provider: "wispr_flow", accessToken: "a", refreshToken: "r", expiresAt: "2099", lastSeenAt: null, status: "active" });
    const { meeting: before } = await s.upsertMeeting({ userId: u.id, providerMeetingId: "p0", title: "Old", startedAt: "2026-11-19T05:00:00Z", participants: [] });
    const { meeting: m } = await s.upsertMeeting({ userId: u.id, providerMeetingId: "p1", title: "Sync", startedAt: "2026-11-20T05:00:00Z", participants: [] });
    const { meeting: after } = await s.upsertMeeting({ userId: u.id, providerMeetingId: "p2", title: "Later", startedAt: "2026-11-21T05:00:00Z", participants: [] });
    const base = { quote: "q", dueAt: null };
    await s.commitExtraction({
      meetingId: before.id, userId: u.id, at: "2026-11-19T06:00:00Z", closes: [],
      newItems: [
        { ...base, kind: "decision", text: "Ship the banner without the tooltip", person: null, meetingId: before.id },
        { ...base, kind: "owe", text: "Send the deck", person: "Ravi", meetingId: before.id },
      ],
    });
    await s.commitExtraction({
      meetingId: after.id, userId: u.id, at: "2026-11-21T06:00:00Z", closes: [],
      newItems: [{ ...base, kind: "decision", text: "A later decision", person: null, meetingId: after.id }],
    });
    let seen: ExtractionInput | null = null;
    await processMeeting({
      store: s, model: "m", now: () => new Date("2026-11-22T07:00:00Z"), costInr: () => 0,
      wispr: () => ({ getTranscript: async () => "Ravi: hi" }) as never,
      extract: async (i) => { seen = i; return { newItems: [], closes: [], usage: { inputTokens: 1, outputTokens: 1 } }; },
    }, m.id);
    expect(seen!.openDecisions).toEqual([{ text: "Ship the banner without the tooltip" }]);
    expect(seen!.openItems.map((i) => i.text)).toEqual(["Send the deck"]);
    expect(MAX_OPEN_DECISIONS).toBeGreaterThan(0);
  });

  it("leaves openDecisions out when there are none", async () => {
    const s = new MemoryStore();
    const u = s.addUser({ email: "a@b", name: "Me" });
    await s.saveConnection({ userId: u.id, provider: "wispr_flow", accessToken: "a", refreshToken: "r", expiresAt: "2099", lastSeenAt: null, status: "active" });
    const { meeting: m } = await s.upsertMeeting({ userId: u.id, providerMeetingId: "p1", title: "Sync", startedAt: "2026-11-20T05:00:00Z", participants: [] });
    let seen: ExtractionInput | null = null;
    await processMeeting({
      store: s, model: "m", now: () => new Date("2026-11-22T07:00:00Z"), costInr: () => 0,
      wispr: () => ({ getTranscript: async () => "Ravi: hi" }) as never,
      extract: async (i) => { seen = i; return { newItems: [], closes: [], usage: { inputTokens: 1, outputTokens: 1 } }; },
    }, m.id);
    expect(seen).not.toHaveProperty("openDecisions");
  });
});
