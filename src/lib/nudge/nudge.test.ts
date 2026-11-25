import { describe, expect, it } from "vitest";
import { fakeCreate, message, toolCall } from "../ai/fakes.test-helpers";
import type { HandoffContext } from "../handoff/types";
import type { Item } from "../types";
import { buildNudgeMessage, draftNudge, overdueWaiting } from "./nudge";

const NOW = new Date("2026-11-25T10:00:00Z");
const item = (over: Partial<Item>): Item => ({
  id: "i", userId: "u", kind: "waiting", text: "Nitin to share the payout calendar", person: "Nitin K", quote: "I'll share the payout calendar",
  meetingId: "m", dueAt: "2026-11-20T12:00:00Z", status: "open", closedByMeetingId: null, closeQuote: null, createdAt: "2026-11-19T00:00:00Z", closedAt: null, ...over,
});
const ctx = (quote = "I'll share the payout calendar"): HandoffContext => ({
  user: { name: "Maruthi", timeZone: "Asia/Kolkata" },
  item: { id: "i", kind: "waiting", text: "Nitin to share the payout calendar", person: "Nitin K", quote, dueAt: "2026-11-20T12:00:00Z" },
  meeting: { title: "Dividend sync", startedAt: "2026-11-19T06:00:00Z" },
  related: [],
  now: NOW.toISOString(),
});

describe("overdueWaiting", () => {
  it("keeps open waiting items 3+ days past due, most overdue first", () => {
    const got = overdueWaiting([
      item({ id: "a", dueAt: "2026-11-21T12:00:00Z" }),
      item({ id: "b", dueAt: "2026-11-10T12:00:00Z" }),
      item({ id: "c", dueAt: "2026-11-23T12:00:00Z" }), // 2 days
      item({ id: "d", dueAt: null }),
      item({ id: "e", status: "done" }),
      item({ id: "f", kind: "owe" }),
    ], NOW);
    expect(got.map((i) => i.id)).toEqual(["b", "a"]);
  });
});

describe("draftNudge", () => {
  it("uses Claude's nudge when it passes the checks", async () => {
    const client = fakeCreate(toolCall("write_nudge", { message: "Hey Nitin, any update on the payout calendar? Do let me know when you can share it." }));
    const r = await draftNudge(ctx(), { client, model: "claude-sonnet-5-5" });
    expect(r).toMatchObject({ source: "ai", fallback: null, text: expect.stringContaining("payout calendar") });
    expect(client.calls[0].tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
    expect(client.calls[0].messages[0].content).toContain("Quote is Hinglish: no");
  });
  it("tells the model when the quote is Hinglish", () => {
    expect(buildNudgeMessage(ctx("haan main kal bhej dunga calendar"))).toContain("Quote is Hinglish: yes");
  });
  it("falls back to the template on errors, missing tool calls and failed checks", async () => {
    const t = (await draftNudge(ctx(), { client: fakeCreate(new Error("down")), model: "m" }));
    expect(t).toMatchObject({ source: "template", fallback: "api error: Error" });
    expect(t.text).toContain("Hi Nitin");
    expect((await draftNudge(ctx(), { client: fakeCreate(message([])), model: "m" })).fallback).toBe("no tool call");
    const shouty = await draftNudge(ctx(), { client: fakeCreate(toolCall("write_nudge", { message: "Hey Nitin! Where is it?" })), model: "m" });
    expect(shouty.source).toBe("template");
    const hinglish = await draftNudge(ctx(), { client: fakeCreate(toolCall("write_nudge", { message: "Hey Nitin, calendar ka kya hua yaar, kab tak bhejoge?" })), model: "m" });
    expect(hinglish.source).toBe("template"); // Hinglish only when the quote was
  });
});
