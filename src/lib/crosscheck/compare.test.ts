import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type { AnthropicLike } from "../extract/extract";
import { AnthropicCallError } from "../extract/errors";
import { buildMessage, classify, compareMeeting, openMissed, totals, TOOL, TOOL_NAME, type AppItem, type CrossCheckRecord } from "./compare";
import type { WisprAction } from "./parse";

const user = { name: "Maruthi", aliases: ["Maru", "MR"] };
const meeting = { title: "Launch sync", participants: ["Maruthi", "Asha", "Ravi"] };
const wispr: WisprAction[] = [
  { text: "Send the press list to Asha", owner: "Maruthi" },
  { text: "Draft the announcement post", owner: "Asha" },
  { text: "Review the pricing page", owner: "Ravi" },
  { text: "Share the dashboard with Maru", owner: "Ravi" },
  { text: "Book the venue", owner: null },
];
const app: AppItem[] = [
  { id: "i1", kind: "owe", text: "Send Asha the press contacts", person: "Asha", status: "open" },
  { id: "i2", kind: "waiting", text: "Ravi to review pricing", person: "Ravi", status: "wrong" },
  { id: "i3", kind: "owe", text: "Call the printer", person: null, status: "done" },
  { id: "i4", kind: "decision", text: "Launch on Monday", person: null, status: "open" },
];
const dropped = [{ text: "Asha to draft the post", reason: "not the user's" }];

function fake(respond: (body: Anthropic.MessageCreateParamsNonStreaming) => unknown): { client: AnthropicLike; bodies: Anthropic.MessageCreateParamsNonStreaming[] } {
  const bodies: Anthropic.MessageCreateParamsNonStreaming[] = [];
  return {
    bodies,
    client: {
      messages: {
        create: (async (body: Anthropic.MessageCreateParamsNonStreaming) => {
          bodies.push(body);
          const input = respond(body);
          if (input instanceof Error) throw input;
          return {
            id: "m", type: "message", role: "assistant", model: body.model, stop_reason: input ? "tool_use" : "end_turn", stop_sequence: null,
            content: input ? [{ type: "tool_use", id: "t", name: TOOL_NAME, input }] : [{ type: "text", text: "hi", citations: null }],
            usage: { input_tokens: 900, output_tokens: 120, cache_creation_input_tokens: null, cache_read_input_tokens: null },
          };
        }) as unknown as AnthropicLike["messages"]["create"],
      },
    },
  };
}

const rows = {
  items: [
    { w: 1, match: "A1", involves_user: true, kind: "owe", person: "Asha" },
    { w: 2, match: "D1", involves_user: false, kind: null, person: null },
    { w: 3, match: "a2", involves_user: true, kind: "waiting", person: "Ravi" },
    { w: 4, match: null, involves_user: true, kind: "waiting", person: "Ravi" },
    { w: 5, match: null, involves_user: false, kind: null, person: null },
  ],
};

describe("compareMeeting", () => {
  it("classifies each Wispr item and lists what only Daily brief has", async () => {
    const f = fake(() => rows);
    const r = await compareMeeting({ user, meeting, summary: "## Next steps\n- Maruthi: send the press list", wispr, app, dropped }, { client: f.client, model: "claude-plan:sonnet", retry: { retries: 0 } });
    expect(r.error).toBeNull();
    expect(r.entries.map((e) => e.verdict)).toEqual(["matched", "not_user", "matched_wrong", "missed", "not_user"]);
    expect(r.entries[0].itemId).toBe("i1");
    expect(r.entries[1].droppedReason).toBe("not the user's");
    expect(r.entries[3]).toMatchObject({ kind: "waiting", person: "Ravi", itemId: null });
    // i3 is unmatched; i2 is wrong (and matched), i4 is a decision.
    expect(r.onlyInApp).toEqual(["i3"]);
    expect(r.usage).toEqual({ inputTokens: 900, outputTokens: 120 });
    // The qualified model name goes to the client as is (claude-plan strips its prefix itself).
    expect(f.bodies[0].model).toBe("claude-plan:sonnet");
    expect(f.bodies[0].tools?.[0]).toBe(TOOL);
  });

  it("sends names, aliases, items and the summary, never a transcript", async () => {
    const f = fake(() => rows);
    await compareMeeting({ user, meeting, summary: "SUMMARY TEXT", wispr, app, dropped }, { client: f.client, model: "m", retry: { retries: 0 } });
    const msg = f.bodies[0].messages[0].content as string;
    expect(msg).toContain("The user: Maruthi (also called Maru, MR)");
    expect(msg).toContain("W1. [owner: Maruthi] Send the press list to Asha");
    expect(msg).toContain("A2. (user is waiting on, Ravi) Ravi to review pricing");
    expect(msg).toContain("D1. (not the user's) Asha to draft the post");
    expect(msg).toContain("SUMMARY TEXT");
    expect(Object.keys(f.bodies[0])).not.toContain("transcript");
  });

  it("makes no call when Wispr lists nothing", async () => {
    const f = fake(() => rows);
    const r = await compareMeeting({ user, meeting, summary: null, wispr: [], app, dropped: [] }, { client: f.client, model: "m" });
    expect(f.bodies).toHaveLength(0);
    expect(r.onlyInApp).toEqual(["i1", "i3"]);
  });

  it("returns API failures and missing tool calls as errors", async () => {
    const bad = await compareMeeting({ user, meeting, summary: null, wispr, app, dropped }, { client: fake(() => new AnthropicCallError("auth", 401)).client, model: "m", retry: { retries: 0 } });
    expect(bad).toMatchObject({ error: "api error: auth", failure: "auth", entries: [] });
    const none = await compareMeeting({ user, meeting, summary: null, wispr, app, dropped }, { client: fake(() => null).client, model: "m", retry: { retries: 0 } });
    expect(none.error).toMatch(/no tool call/);
  });
});

describe("classify and totals", () => {
  it("treats a skipped or out-of-range row as not the user's", () => {
    const r = classify(wispr.slice(0, 2), app, [], [{ w: 1, match: "A9", involves_user: false, kind: null, person: null }]);
    expect(r.entries.map((e) => e.verdict)).toEqual(["not_user", "not_user"]);
  });
  it("defaults a missed item to You owe", () => {
    const r = classify(wispr.slice(0, 1), [], [], [{ w: 1, match: null, involves_user: true, kind: null, person: null }]);
    expect(r.entries[0]).toMatchObject({ verdict: "missed", kind: "owe" });
  });
  it("counts totals and leaves ignored or added items out of missed", () => {
    const rec = (over: Partial<CrossCheckRecord>): CrossCheckRecord => ({ meetingId: "m", userId: "u", checkedAt: "", status: "ok", model: "m", entries: [], onlyInApp: [], ...over });
    const e = (verdict: CrossCheckRecord["entries"][number]["verdict"], extra = {}) => ({ wispr: wispr[0], verdict, itemId: null, kind: null, person: null, ...extra });
    const t = totals([
      rec({ entries: [e("matched"), e("missed"), e("missed", { ignored: true }), e("missed", { addedItemId: "x" }), e("not_user"), e("matched_wrong")], onlyInApp: ["a", "b"] }),
      rec({ status: "no_summary", onlyInApp: ["c"] }),
    ]);
    expect(t).toEqual({ matched: 2, missed: 1, onlyInApp: 2, notYours: 1, markedWrong: 1, meetings: 1 });
    expect(openMissed(rec({ entries: [e("missed"), e("missed", { ignored: true })] })).map((x) => x.i)).toEqual([0]);
  });
  it("buildMessage says when there are no app items", () => {
    expect(buildMessage({ user, meeting, summary: null, wispr, app: [], dropped: [] })).toContain("A (the tracker's items for the user):\n(none)");
  });
});
