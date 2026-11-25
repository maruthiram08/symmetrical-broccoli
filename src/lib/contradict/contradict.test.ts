import { describe, expect, it } from "vitest";
import { fakeCreate, toolCall } from "../ai/fakes.test-helpers";
import type { Item, Meeting } from "../types";
import { findCandidates, judge, topicSimilarity } from "./contradict";

const meetings = new Map<string, Meeting>([
  ["m1", { id: "m1", userId: "u", providerMeetingId: "1", title: "Banner review", startedAt: "2026-11-20T06:00:00Z", participants: [], processedAt: "x" }],
  ["m2", { id: "m2", userId: "u", providerMeetingId: "2", title: "Ops sync", startedAt: "2026-11-22T06:00:00Z", participants: [], processedAt: "x" }],
  ["m3", { id: "m3", userId: "u", providerMeetingId: "3", title: "Standup", startedAt: "2026-11-25T04:00:00Z", participants: [], processedAt: "x" }],
]);
const d = (id: string, text: string, meetingId: string, over: Partial<Item> = {}): Item => ({
  id, userId: "u", kind: "decision", text, person: null, quote: text.toLowerCase(), meetingId, dueAt: null,
  status: "open", closedByMeetingId: null, closeQuote: null, createdAt: "2026-11-25T05:00:00Z", closedAt: null, ...over,
});
const old1 = d("o1", "Ship the dividend banner on Friday", "m1");
const old2 = d("o2", "Move standup to 9:30", "m2");
const old3 = d("o3", "Ship banners to all users", "m2", { status: "wrong" });
const fresh = d("n1", "Ship the dividend banner on Monday instead", "m3");
const later = d("n2", "Show the dividend banner only to holders", "m3");

describe("findCandidates", () => {
  it("picks earlier decisions on the same topic, not later, wrong or same-meeting ones", () => {
    expect(topicSimilarity("Ship the banner Friday", "ship banners on Monday")).toBeGreaterThan(0.2);
    const c = findCandidates(fresh, [old1, old2, old3, fresh, later], meetings);
    expect(c.map((i) => i.id)).toEqual(["o1"]);
    expect(findCandidates(old1, [old1, fresh], meetings)).toEqual([]);
  });
});

describe("judge", () => {
  it("returns the earlier decision the model says changed, with the note", async () => {
    const client = fakeCreate(toolCall("record_verdict", { changes: true, earlier: 1, note: "launch moved from Friday to Monday" }));
    const v = await judge(fresh, [old1], meetings, "Asia/Kolkata", { client, model: "claude-sonnet-5-5" });
    expect(v).toMatchObject({ oldId: "o1", note: "launch moved from Friday to Monday", error: null });
    const msg = client.calls[0].messages[0].content as string;
    expect(msg).toContain("New decision:\nShip the dividend banner on Monday instead");
    expect(msg).toContain("1. Ship the dividend banner on Friday\n   Banner review, 20 Nov 2026");
  });
  it("ignores no-change, out-of-range answers and API errors; no call without candidates", async () => {
    expect((await judge(fresh, [old1], meetings, "UTC", { client: fakeCreate(toolCall("record_verdict", { changes: false, earlier: null, note: "" })), model: "m" })).oldId).toBeNull();
    expect((await judge(fresh, [old1], meetings, "UTC", { client: fakeCreate(toolCall("record_verdict", { changes: true, earlier: 4, note: "x" })), model: "m" })).oldId).toBeNull();
    expect((await judge(fresh, [old1], meetings, "UTC", { client: fakeCreate(new Error("x")), model: "m" })).error).toMatch(/api error/);
    const none = fakeCreate();
    expect((await judge(fresh, [], meetings, "UTC", { client: none, model: "m" })).oldId).toBeNull();
    expect(none.calls).toHaveLength(0);
  });
});
