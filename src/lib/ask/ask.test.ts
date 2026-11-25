import { describe, expect, it } from "vitest";
import { fakeStream } from "../ai/fakes.test-helpers";
import type { Item, Meeting } from "../types";
import { estimateCost, streamAnswer, type AskEvent, type AskInput } from "./ask";
import { citedNumbers, parseCitations } from "./cite";
import { NO_ANSWER, buildAskMessage, fitSources } from "./prompt";
import { MAX_SOURCES, questionTerms, retrieve } from "./retrieve";

const NOW = new Date("2026-11-25T10:00:00Z");
const meetings: Meeting[] = [
  { id: "m1", userId: "u", providerMeetingId: "p1", title: "Dividend sync", startedAt: "2026-11-20T06:00:00Z", participants: ["Tarun"], processedAt: "x" },
  { id: "m2", userId: "u", providerMeetingId: "p2", title: "Standup", startedAt: "2026-11-24T06:00:00Z", participants: ["Priya"], processedAt: "x" },
];
let seq = 0;
const item = (over: Partial<Item>): Item => ({
  id: `i${++seq}`, userId: "u", kind: "owe", text: "", person: null, quote: "q", meetingId: "m1", dueAt: null,
  status: "open", closedByMeetingId: null, closeQuote: null, createdAt: "2026-11-20T07:00:00Z", closedAt: null, ...over,
});
const items: Item[] = [
  item({ kind: "decision", text: "Show the dividend banner only to holders", quote: "let's only show the banner to holders" }),
  item({ kind: "owe", text: "Send Tarun the banner copy", person: "Tarun", quote: "I'll send you the banner copy", dueAt: "2026-11-21T12:00:00Z" }),
  item({ kind: "waiting", text: "Priya to book the venue", person: "Priya", quote: "main venue book kar dungi", meetingId: "m2", dueAt: "2026-11-22T12:00:00Z" }),
  item({ kind: "owe", text: "Review the onboarding deck", person: "Priya", meetingId: "m2", status: "wrong" }),
];

async function collect(gen: AsyncGenerator<AskEvent>): Promise<AskEvent[]> {
  const out: AskEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const input = (q: string): AskInput => ({ question: q, sources: retrieve(q, items, meetings, NOW), userName: "Maruthi", timeZone: "Asia/Kolkata", now: NOW });

describe("retrieve", () => {
  it("drops stopwords and finds items by content words, best first", () => {
    expect(questionTerms("What did we decide about the dividend banner?")).toEqual(["decide", "dividend", "banner"]);
    const s = retrieve("What did we decide about the dividend banner?", items, meetings, NOW);
    expect(s[0].text).toBe("Show the dividend banner only to holders");
    expect(s.map((x) => x.n)).toEqual(s.map((_, k) => k + 1));
  });
  it("fills from kind hints and never includes wrong items", () => {
    const s = retrieve("who is late on something?", items, meetings, NOW);
    expect(s.map((x) => x.text).sort()).toEqual(["Priya to book the venue", "Send Tarun the banner copy"]);
    expect(retrieve("anything about onboarding deck", items, meetings, NOW)).toEqual([]);
  });
  it("returns nothing for unrelated questions and caps at MAX_SOURCES", () => {
    expect(retrieve("what is the capital of France", items, meetings, NOW)).toEqual([]);
    const many = Array.from({ length: 100 }, (_, k) => item({ text: `Banner task ${k}` }));
    expect(retrieve("banner", many, meetings, NOW)).toHaveLength(MAX_SOURCES);
  });
  it("caps the context size", () => {
    const big = Array.from({ length: 40 }, (_, k) => item({ text: `Banner task ${k}`, quote: "x".repeat(200) }));
    const s = retrieve("banner", big, meetings, NOW);
    const fit = fitSources(s, "Asia/Kolkata", 3000);
    expect(fit.length).toBeLessThan(s.length);
    expect(buildAskMessage("q", fit, { userName: "M", timeZone: "Asia/Kolkata", now: NOW }).length).toBeLessThan(3400);
  });
});

describe("streamAnswer", () => {
  it("streams text and reports cost; sends no transcript, only numbered items", async () => {
    const client = fakeStream(["You decided to show it ", "only to holders [1]."]);
    const ev = await collect(streamAnswer(input("what did we decide about the dividend banner"), { client, model: "claude-sonnet-5-5" }));
    expect(ev.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("")).toBe("You decided to show it only to holders [1].");
    const done = ev.at(-1)!;
    expect(done).toMatchObject({ type: "done", noAnswer: false, usage: { inputTokens: 1000, outputTokens: 100 } });
    // 1000 in, 100 out at $2/$10 per Mtok = $0.003 = ₹0.264
    expect((done as { costInr: number }).costInr).toBeCloseTo(0.264, 3);
    const body = client.calls[0];
    expect(body.model).toBe("claude-sonnet-5-5");
    const msg = body.messages[0].content as string;
    expect(msg).toContain('[1] Decision · open');
    expect(msg).toContain('"let\'s only show the banner to holders"');
    expect(body.system).toContain(NO_ANSWER);
  });
  it("answers 'I don't see that' with no model call when nothing matches", async () => {
    const client = fakeStream(["nope"]);
    const ev = await collect(streamAnswer(input("capital of France"), { client, model: "claude-sonnet-5-5" }));
    expect(ev).toEqual([{ type: "text", text: NO_ANSWER }, { type: "done", usage: null, costInr: 0, noAnswer: true }]);
    expect(client.calls).toHaveLength(0);
  });
  it("flags the model's no-answer reply, and turns API errors into a message", async () => {
    const no = await collect(streamAnswer(input("banner"), { client: fakeStream([NO_ANSWER]), model: "claude-sonnet-5-5" }));
    expect(no.at(-1)).toMatchObject({ type: "done", noAnswer: true });
    const err = Object.assign(new Error("rate"), { status: 429 });
    const bad = await collect(streamAnswer(input("banner"), { client: fakeStream([], {}, err), model: "claude-sonnet-5-5" }));
    expect(bad).toEqual([{ type: "error", error: "Claude is busy right now. Try again in a minute.", failure: "transient" }]);
    const refused = await collect(streamAnswer(input("banner"), { client: fakeStream(["x"], { stop_reason: "refusal" }), model: "claude-sonnet-5-5" }));
    expect(refused.at(-1)).toMatchObject({ type: "error" });
  });
  it("estimates cost before asking", () => {
    const e = estimateCost(input("banner"), "claude-sonnet-5-5");
    expect(e.inputTokens).toBeGreaterThan(200);
    expect(e.costInr).toBeGreaterThan(0);
    expect(e.costInr).toBeLessThan(2);
    expect(estimateCost(input("banner"), "unknown-model").costInr).toBeNull();
  });
});

describe("citations", () => {
  it("splits [n] and [n, m] and ignores numbers out of range", () => {
    expect(parseCitations("A [1][3] b [2, 1] c [9] d", 3)).toEqual([
      { type: "text", text: "A " }, { type: "cite", n: 1 }, { type: "cite", n: 3 }, { type: "text", text: " b " },
      { type: "cite", n: 2 }, { type: "cite", n: 1 }, { type: "text", text: " c [9] d" },
    ]);
    expect(citedNumbers("x [2] y [1] z [2]", 3)).toEqual([2, 1]);
  });
});
