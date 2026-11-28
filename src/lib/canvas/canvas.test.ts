import { describe, expect, it } from "vitest";
import type { Item, Meeting } from "../types";
import { buildCombine, buildConflict, buildMap, buildPrep, buildStart, buildWeek, mondayOf, startContext, type Ctx } from "./build";
import { findSlots, nextAt } from "./recurring";
import { findTopics, meetingsAbout } from "./topics";
import { words, pairs, mentions } from "./text";

const TZ = "Asia/Calcutta";
let n = 0;
const meeting = (title: string, startedAt: string, participants: string[] = []): Meeting =>
  ({ id: `m${++n}`, userId: "u", providerMeetingId: `p${n}`, title, startedAt, participants: ["Maruthi Ram", ...participants], processedAt: startedAt });
const item = (m: Meeting, kind: Item["kind"], text: string, extra: Partial<Item> = {}): Item =>
  ({ id: `i${++n}`, userId: "u", kind, text, person: null, quote: `${text} (said)`, meetingId: m.id, dueAt: null, status: "open", closedByMeetingId: null, closeQuote: null, createdAt: m.startedAt, closedAt: null, ...extra });

const m1 = meeting("SanDisk Stock Split Implementation", "2026-11-10T10:28:00Z", ["Jaishil", "Speaker 5"]);
const m2 = meeting("Stock Split Tag Implementation", "2026-11-12T11:17:00Z", ["Rajat"]);
const m3 = meeting("Trading Platform Auction Debugging", "2026-11-20T14:29:00Z", ["Manku Pathak"]);
const m4 = meeting("Dividend and Stock Action Banner", "2026-11-25T08:21:00Z", ["Nitin Kacharia"]);
const m5 = meeting("MVP Banner and Chart Discussion", "2026-11-26T11:02:00Z", ["Jaishil", "Nikhil saxena"]);
const d1 = item(m1, "decision", "Split ships first: tags, remarks and cancel-only mode");
const w1 = item(m1, "waiting", "Chart history cache invalidation", { person: "Manku Pathak" });
const o1 = item(m2, "owe", "Create the stock split Jira tickets", { person: "Rajat", status: "done", closedByMeetingId: m3.id, closedAt: "2026-11-20T16:00:00Z" });
const dA = item(m4, "decision", "Banner strip ships first for dividend");
const oA = item(m4, "owe", "Share the dividend banner text", { person: "Nitin Kacharia" });
const dB = item(m5, "decision", "Banner is out of the MVP; added after Monday");
const oB = item(m5, "owe", "Write a Jira for the orange limit line", { person: "Jaishil" });
const ctx = (now = "2026-11-26T14:00:00Z"): Ctx => ({ items: [d1, w1, o1, dA, oA, dB, oB], meetings: [m1, m2, m3, m4, m5], self: ["Maruthi Ram", "Maruthi"], timeZone: TZ, now: new Date(now) });

describe("text", () => {
  it("drops filler words and plurals", () => {
    expect(words("Corporate Actions Configuration Plan")).toEqual(["corporate", "action", "configuration"]);
    expect(pairs("SanDisk Stock Split Discussion")).toContain("stock split");
    expect(mentions("Sandisk stock splits on the 20th", "stock split")).toBe(true);
  });
});

describe("topics", () => {
  it("finds a phrase two meetings share, and prefers it to its single words", () => {
    const t = findTopics(ctx().meetings, ctx().items, "2026-11-01T00:00:00Z");
    expect(t[0].key).toBe("stock split");
    expect(t[0].meetingIds).toEqual([m1.id, m2.id]);
    expect(t.some((x) => x.key === "stock")).toBe(false);
    expect(t.some((x) => x.key === "banner")).toBe(true);
  });
  it("matches meetings by title, oldest first", () => {
    expect(meetingsAbout("banner", [m5, m4], ctx().items).map((m) => m.id)).toEqual([m4.id, m5.id]);
  });
});

describe("recurring", () => {
  it("finds a meeting at the same time on three days, and its next weekday", () => {
    const ms = ["2026-11-24", "2026-11-25", "2026-11-26"].map((d) => meeting("Standup", `${d}T05:31:00Z`, ["Jaishil"]));
    const s = findSlots(ms, new Date("2026-11-26T14:00:00Z"), TZ);
    expect(s).toHaveLength(1);
    expect(s[0].label).toBe("11:00 AM");
    expect(s[0].next).toBe("2026-11-27T05:30:00.000Z");
    // Friday evening → Monday.
    expect(nextAt(660, new Date("2026-11-27T14:00:00Z"), TZ)).toBe("2026-11-30T05:30:00.000Z");
  });
});

describe("views", () => {
  it("project map: a column per meeting, a close line from the meeting that closed an item, no speaker labels", () => {
    const d = buildMap("stock split", ctx());
    expect(d.nodes.filter((x) => x.kind === "meeting").map((x) => x.meetingId)).toEqual([m1.id, m2.id]);
    expect(d.nodes.find((x) => x.itemId === o1.id)?.done).toBe(true);
    expect(d.nodes.find((x) => x.itemId === o1.id)?.label).toContain("closed 20 Nov");
    expect(d.edges).toContainEqual({ from: `meeting:${m1.id}`, to: `item:${d1.id}`, kind: "from" });
    expect(JSON.stringify(d)).not.toContain("Speaker 5");
    expect(buildMap("nothing like this", ctx()).empty).toBeTruthy();
  });

  it("prep: earlier meetings and open items, all wired to Ask", () => {
    const d = buildPrep({ key: "person:jaishil", title: "Jaishil", at: null, meetings: [m5, m1], people: ["Jaishil"] }, ctx());
    expect(d.nodes.some((x) => x.itemId === oB.id)).toBe(true);
    expect(d.nodes.some((x) => x.itemId === w1.id)).toBe(true); // from a context meeting
    expect(d.nodes.some((x) => x.itemId === o1.id)).toBe(false); // done
    const ctxEdges = d.edges.filter((e) => e.kind === "ctx");
    expect(ctxEdges.length).toBe(d.nodes.filter((x) => x.context).length);
    expect(ctxEdges.every((e) => e.to === "ask")).toBe(true);
  });

  it("start: the item, its words, its meeting and decisions feed the new window", () => {
    const d = buildStart(oB, [{ id: "w", itemId: oB.id, kind: "claude", title: "Claude", status: "ready", output: "Draft", createdAt: "2026-11-26T12:00:00Z" }], ctx());
    expect(d.nodes.map((x) => x.id)).toEqual(expect.arrayContaining([`item:${oB.id}`, "quote", `meeting:${m5.id}`, `item:${dB.id}`, "launch", "window:w"]));
    const text = startContext(oB, ctx(), "Maruthi Ram");
    expect(text).toContain("What I owe: Write a Jira for the orange limit line");
    expect(text).toContain("Banner is out of the MVP");
    expect(text).toContain("with Jaishil, Nikhil saxena");
  });

  it("combine: two disagreeing decisions with who was where and resolve buttons", () => {
    const d = buildConflict({ id: "c1", note: "banner moved after the MVP", oldId: dA.id, newId: dB.id }, ctx())!;
    const c = d.nodes.find((x) => x.id === "conflict")!;
    expect(c.actions?.map((a) => a.type)).toEqual(["resolve", "resolve"]);
    expect(c.sub).toContain("Jaishil, Nikhil saxena only in the later one");
    expect(d.nodes.some((x) => x.itemId === oA.id)).toBe(true); // tied to the old decision
    expect(buildConflict({ id: "x", note: "", oldId: "gone", newId: dB.id }, ctx())).toBeNull();
    expect(buildCombine(m5, m4, ctx()).nodes.find((x) => x.id === "both")?.title).toContain("banner");
  });

  it("week: decided, open, stuck and a next-week drop zone", () => {
    const d = buildWeek(mondayOf("2026-11-26"), ctx());
    expect(mondayOf("2026-11-26")).toBe("2026-11-23");
    const inZone = (z: string) => d.nodes.filter((x) => x.stack === z).map((x) => x.itemId);
    expect(inZone("decided")).toEqual(expect.arrayContaining([dA.id, dB.id]));
    expect(inZone("open")).toEqual(expect.arrayContaining([oA.id, oB.id]));
    expect(inZone("stuck")).toEqual([w1.id]);
    expect(d.nodes.find((x) => x.id === "zone:next")?.drop).toBe("next-week");
    const snoozed = { ...oA, snoozedUntil: "2026-11-30T03:30:00Z" };
    const d2 = buildWeek("2026-11-23", { ...ctx(), items: [d1, w1, o1, dA, snoozed, dB, oB] });
    expect(d2.nodes.filter((x) => x.stack === "next").map((x) => x.itemId)).toEqual([oA.id]);
  });
});
