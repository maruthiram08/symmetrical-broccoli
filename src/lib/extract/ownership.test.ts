import { describe, expect, it } from "vitest";
import type { ExtractionInput } from "../types";
import { TOOL_NAME } from "./prompt";
import { extractMeeting, notTheUsers, postProcess, type AnthropicLike, type ModelOutput, type PostProcessReport } from "./extract";

type Item = ModelOutput["newItems"][number];
const base = { text: "x", person: "Nitin", quote: "q", dueAt: null } as const;
const item = (o: Partial<Item>): Item => ({ kind: "owe", ...base, ...o }) as Item;

describe("notTheUsers", () => {
  it("keeps the user's own promises and promises made to the user", () => {
    expect(notTheUsers(item({ kind: "owe", madeBy: "user", madeTo: "other" }))).toBeNull();
    expect(notTheUsers(item({ kind: "owe", madeBy: "user", madeTo: "room" }))).toBeNull();
    expect(notTheUsers(item({ kind: "waiting", madeBy: "other", madeTo: "user" }))).toBeNull();
    expect(notTheUsers(item({ kind: "waiting", madeBy: "other", madeTo: "room" }))).toBeNull();
    expect(notTheUsers(item({ kind: "decision", madeBy: "none", madeTo: "none" }))).toBeNull();
  });

  it("drops a promise between two other people", () => {
    expect(notTheUsers(item({ kind: "waiting", madeBy: "other", madeTo: "other" }))).toMatch(/two other people/);
    expect(notTheUsers(item({ kind: "owe", madeBy: "other", madeTo: "other" }))).toMatch(/did not take on/);
  });

  it("drops items whose kind contradicts who promised", () => {
    expect(notTheUsers(item({ kind: "owe", madeBy: "other", madeTo: "user" }))).not.toBeNull();
    expect(notTheUsers(item({ kind: "waiting", madeBy: "user", madeTo: "other" }))).not.toBeNull();
  });

  it("keeps items when the model didn't say (older outputs)", () => {
    expect(notTheUsers(item({ kind: "waiting" }))).toBeNull();
    expect(notTheUsers(item({ kind: "owe" }))).toBeNull();
  });
});

describe("postProcess", () => {
  const transcript = `Rahul: Priya, I'll send you the build tonight.
Priya: Thanks.
Nitin: Maruthi, I'll share the API doc with you tomorrow.`;
  const input: ExtractionInput = {
    transcript,
    user: { name: "Maruthi", aliases: [], timeZone: "Asia/Kolkata" },
    meeting: { title: "Stand-up", startedAt: "2026-11-26T04:30:00.000Z", participants: [] },
    openItems: [],
  };

  it("leaves out other people's promises to each other and reports why", () => {
    const report: PostProcessReport = { droppedItems: [], droppedCloses: [] };
    const out = postProcess(
      {
        newItems: [
          { kind: "waiting", madeBy: "other", madeTo: "other", text: "Send Priya the build", person: "Rahul", quote: "Priya, I'll send you the build tonight.", dueAt: null },
          { kind: "waiting", madeBy: "other", madeTo: "user", text: "Share the API doc", person: "Nitin", quote: "I'll share the API doc with you tomorrow.", dueAt: null },
        ],
        closes: [],
      },
      input,
      report,
    );
    expect(out.newItems.map((i) => i.person)).toEqual(["Nitin"]);
    expect(report.droppedItems[0].reason).toMatch(/two other people/);
  });
});

describe("extractMeeting reports what it dropped", () => {
  it("returns dropped items with their reason, so the run log can count them", async () => {
    const input: ExtractionInput = {
      transcript: "Rahul: Priya, I'll send you the build tonight.",
      user: { name: "Maruthi", aliases: [], timeZone: "Asia/Kolkata" },
      meeting: { title: "Stand-up", startedAt: "2026-11-26T04:30:00.000Z", participants: [] },
      openItems: [],
    };
    const toolInput = { newItems: [{ kind: "waiting", madeBy: "other", madeTo: "other", text: "Send Priya the build", person: "Rahul", quote: "Priya, I'll send you the build tonight.", dueAt: null }], closes: [] };
    const client = { messages: { create: async () => ({
      stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: "tool_use", id: "t", name: TOOL_NAME, input: toolInput }],
    }) } } as unknown as AnthropicLike;
    const r = await extractMeeting(input, { client, model: "m" });
    expect(r.newItems).toEqual([]);
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped![0]).toMatchObject({ text: "Send Priya the build" });
    expect(r.dropped![0].reason).toMatch(/two other people/);
  });
});
