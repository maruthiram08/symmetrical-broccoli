// The optional `recurrence` field: a promise the user will keep making ("every Monday I'll send…",
// "weekly I'll share the metrics", "har Friday main update bhejunga") becomes a routine suggestion,
// never silently a one-off item. All model calls are faked.
import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type { ExtractionInput } from "../types";
import { MemoryStore } from "@/server/store";
import { processMeeting } from "@/server/jobs/process";
import { connect, FakeWispr, fakeDeps } from "@/server/testing";
import { extractMeeting, OUTPUT_JSON_SCHEMA, type AnthropicLike } from "./extract";
import { SYSTEM_PROMPT, TOOL_NAME } from "./prompt";
import { OLLAMA_SYSTEM_PROMPT } from "./ollama";

const transcript = `Tarun: Maruthi, can you keep me posted on the release?
Maruthi: Haan, har Friday main update bhejunga.
Priya: And the dashboard numbers?
Maruthi: Weekly I'll share the metrics with you.
Maruthi: And I'll send Priya the launch deck tomorrow.`;

const input: ExtractionInput = {
  transcript,
  user: { name: "Maruthi", aliases: [], timeZone: "Asia/Kolkata" },
  meeting: { title: "Release sync", startedAt: "2026-11-26T06:00:00.000Z", participants: ["Maruthi", "Tarun", "Priya"] },
  openItems: [],
};

const output = {
  newItems: [
    { kind: "owe", madeBy: "user", madeTo: "other", text: "Send Tarun the release update", person: "Tarun", quote: "har Friday main update bhejunga", dueAt: null, recurrence: "every Friday" },
    { kind: "owe", madeBy: "user", madeTo: "other", text: "Share the metrics with Priya", person: "Priya", quote: "Weekly I'll share the metrics with you.", dueAt: null, recurrence: "weekly" },
    { kind: "owe", madeBy: "user", madeTo: "other", text: "Send Priya the launch deck", person: "Priya", quote: "I'll send Priya the launch deck tomorrow.", dueAt: "2026-11-27T12:30:00Z" },
    { kind: "waiting", madeBy: "other", madeTo: "user", text: "Tarun to send notes", person: "Tarun", quote: "Maruthi, can you keep me posted on the release?", dueAt: null, recurrence: "every day" },
  ],
  closes: [],
};

function fake(toolInput: unknown) {
  const create = vi.fn(async () => ({
    id: "m", type: "message", role: "assistant", model: "x", stop_reason: "tool_use", stop_sequence: null,
    content: [{ type: "tool_use", id: "t", name: TOOL_NAME, input: toolInput }],
    usage: { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: null, cache_read_input_tokens: null },
  }) as unknown as Anthropic.Message);
  const client: AnthropicLike = { messages: { create } };
  return client;
}

describe("recurrence in the tool schema and prompt", () => {
  it("is an optional string on new items", () => {
    const item = (OUTPUT_JSON_SCHEMA.properties as Record<string, { items: { required: string[]; properties: Record<string, { type?: string }> } }>).newItems.items;
    expect(item.properties.recurrence).toMatchObject({ type: "string" });
    expect(item.required).not.toContain("recurrence");
  });

  it("has one short rule, with English and Hinglish examples, in both prompts", () => {
    for (const p of [SYSTEM_PROMPT, OLLAMA_SYSTEM_PROMPT]) {
      expect(p).toMatch(/^- recurrence: only on an owe item the user explicitly says they will do regularly/m);
      expect(p).toContain("weekly I'll share the metrics");
      expect(p).toContain("har Friday main update bhejunga");
    }
    expect(SYSTEM_PROMPT.match(/recurrence/g)).toHaveLength(1);
  });
});

describe("recurrence from the model", () => {
  it("passes through on owe items (Hinglish and English), not on waiting items or one-offs", async () => {
    const r = await extractMeeting(input, { client: fake(output), model: "m" });
    expect(r.newItems.map((i) => [i.text, i.recurrence])).toEqual([
      ["Send Tarun the release update", "every Friday"],
      ["Share the metrics with Priya", "weekly"],
      ["Send Priya the launch deck", undefined],
      ["Tarun to send notes", undefined],
    ]);
  });

  it("older answers without the field, or with null, still validate", async () => {
    const r = await extractMeeting(input, { client: fake({ newItems: [{ ...output.newItems[2] }, { ...output.newItems[0], recurrence: null }], closes: [] }), model: "m" });
    expect(r.newItems.every((i) => i.recurrence === undefined)).toBe(true);
  });
});

describe("recurring promises become suggestions, not items", () => {
  async function run(store: MemoryStore) {
    const wispr = new FakeWispr();
    const user = store.addUser({ email: "a@x", name: "Maruthi" });
    connect(store, user.id);
    const { meeting } = await store.upsertMeeting({ userId: user.id, providerMeetingId: "p1", title: "Release sync", startedAt: input.meeting.startedAt, participants: [] });
    wispr.transcripts.set("p1", transcript);
    const { deps } = fakeDeps({ store, wispr, now: new Date("2026-11-26T07:00:00Z"), extract: (i) => extractMeeting(i, { client: fake(output), model: "m" }) });
    const res = await processMeeting(deps, meeting.id);
    return { user, meeting, res };
  }

  it("saves a suggestion per recurring owe item and keeps the rest as items", async () => {
    const store = new MemoryStore();
    const { user, meeting, res } = await run(store);
    expect(res).toEqual({ status: "processed", newItems: 2, closes: 0 });
    expect((await store.listItems(user.id)).map((i) => i.text)).toEqual(["Send Priya the launch deck", "Tarun to send notes"]);
    const s = await store.listRoutineSuggestions(user.id);
    expect(s.map((x) => [x.title, x.cadence, x.person, x.status, x.meetingId])).toEqual([
      ["Send Tarun the release update", { kind: "weekly", days: [5] }, "Tarun", "open", meeting.id],
      // "weekly" alone counts from the meeting's day (Thursday 26 Nov).
      ["Share the metrics with Priya", { kind: "weekly", days: [4] }, "Priya", "open", meeting.id],
    ]);
    expect(s[0].quote).toBe("har Friday main update bhejunga");
    expect(await store.listRoutines(user.id)).toEqual([]); // nothing becomes a routine without a tap
  });

  it("a re-read doesn't suggest a dismissed one again", async () => {
    const store = new MemoryStore();
    const { user, meeting } = await run(store);
    const [first] = await store.listRoutineSuggestions(user.id);
    await store.setRoutineSuggestionStatus(user.id, first.id, "dismissed");
    store.meetings.get(meeting.id)!.processedAt = null;
    const { deps } = fakeDeps({ store, wispr: Object.assign(new FakeWispr(), { transcripts: new Map([["p1", transcript]]) }), now: new Date(), extract: (i) => extractMeeting(i, { client: fake(output), model: "m" }) });
    await processMeeting(deps, meeting.id);
    expect((await store.listRoutineSuggestions(user.id)).map((x) => x.status)).toEqual(["dismissed", "open"]);
  });

  it("a store without routines (hosted, for now) keeps them as items", async () => {
    class NoRoutines extends MemoryStore {}
    const store = new NoRoutines();
    (store as unknown as { listRoutines: undefined }).listRoutines = undefined;
    const { user, res } = await run(store);
    expect(res).toMatchObject({ newItems: 4 });
    expect(await store.listItems(user.id)).toHaveLength(4);
  });
});
