import { describe, expect, it } from "vitest";
import type { Item, Meeting } from "@/lib/types";
import {
  afterRemoving, backUrl, badgeOf, comingBack, daySentence, doFirst, groupHiding, keyCommand, longDay, openGroups,
  personGroups, projectLine, projectSummaries, SHOW_LIMIT, step, todayGroups, todaySets, todaysMeetings, toRow, visibleIds, type Ctx,
} from "./model";

// 26 Nov 2026, 6 PM in London.
const now = new Date("2026-11-26T18:00:00.000Z");
const tz = "Europe/London";
const meeting = (id: string, startedAt: string, title = `Meeting ${id}`): Meeting => ({ id, userId: "u", providerMeetingId: id, title, startedAt, participants: [], processedAt: startedAt });
const meetings = [meeting("m1", "2026-11-02T11:00:00.000Z", "Team Sprint Progress Review"), meeting("m2", "2026-11-20T11:00:00.000Z"), meeting("today", "2026-11-26T11:00:00.000Z", "MVP Banner")];
const ctx: Ctx = { meetings: new Map(meetings.map((m) => [m.id, m])), timeZone: tz, now };
let n = 0;
const item = (o: Partial<Item>): Item => ({
  id: `i${++n}`, userId: "u", kind: "owe", text: `Item ${n}`, person: "Jit", quote: "I'll do that.", meetingId: "m1", dueAt: null, status: "open",
  closedByMeetingId: null, closeQuote: null, createdAt: "2026-11-02T12:00:00.000Z", closedAt: null, ...o,
});

describe("rows", () => {
  it("shows title, quote, person · meeting · date and an age badge", () => {
    const r = toRow(item({ text: "Explore option screens" }), ctx);
    expect(r).toMatchObject({ title: "Explore option screens", quote: "I'll do that.", meta: "Jit · Team Sprint Progress Review · 2 Nov", badge: "24d", mark: "owe", late: false });
  });
  it("marks late in red with how late, done as kept, decisions by date", () => {
    expect(toRow(item({ dueAt: "2026-11-02T18:00:00.000Z" }), ctx)).toMatchObject({ mark: "late", late: true, badge: "24d late" });
    expect(toRow(item({ status: "done", closedAt: "2026-11-26T10:00:00.000Z" }), ctx)).toMatchObject({ mark: "done", done: true, badge: "Kept 26 Nov" });
    expect(toRow(item({ kind: "decision", person: null }), ctx)).toMatchObject({ mark: "decision", badge: "2 Nov" });
    expect(toRow(item({ kind: "waiting" }), ctx).mark).toBe("waiting");
  });
  it("says when a snoozed item comes back, where asked", () => {
    expect(badgeOf(item({ snoozedUntil: "2026-12-03" }), ctx, { showBack: true })).toBe("Back 3 Dec");
    expect(badgeOf(item({ snoozedUntil: "2026-12-03" }), ctx)).toBe("24d");
  });
  it("uses your note as the quote on items you added", () => {
    expect(toRow(item({ source: "manual", meetingId: "manual", note: "Ring them", quote: "" }), ctx)).toMatchObject({ quote: "Ring them", meta: "Jit · Added by you · 2 Nov" });
  });
});

describe("Today", () => {
  const late = item({ dueAt: "2026-11-20T18:00:00.000Z" });
  const later = item({ dueAt: "2026-11-02T18:00:00.000Z" });
  const fresh = item({ meetingId: "today" });
  const old = item({});
  const back = item({ snoozedUntil: "2026-11-27" });
  const away = item({ snoozedUntil: "2026-12-03" });
  const kept = item({ status: "done", closedAt: "2026-11-26T09:00:00.000Z" });
  const keptBefore = item({ status: "done", closedAt: "2026-11-20T09:00:00.000Z" });
  const all = [late, later, fresh, old, back, away, kept, keptBefore];

  it("groups Late (most late first), today's brief, Back tomorrow and Kept today", () => {
    const g = todayGroups(all, ctx);
    expect(g.map((x) => x.key)).toEqual(["late", "today", "tomorrow", "kept"]);
    expect(g[0].rows.map((r) => r.id)).toEqual([later.id, late.id]);
    expect(g[1].rows.map((r) => r.id)).toEqual([fresh.id]);
    expect(g[2].rows.map((r) => r.id)).toEqual([back.id]);
    expect(g[3].rows.map((r) => r.id)).toEqual([kept.id]);
  });
  it("keeps the named groups when empty, with their empty text, and drops an empty brief group", () => {
    const g = todayGroups([old], ctx);
    expect(g.map((x) => x.key)).toEqual(["late", "tomorrow", "kept"]);
    expect(g.every((x) => x.rows.length === 0 && x.empty)).toBe(true);
  });
  it("puts the most late first in Do first, each with a reason", () => {
    const f = doFirst(all, ctx);
    expect(f.map((x) => x.item.id)).toEqual([later.id, late.id, old.id]);
    expect(f[0].reason).toEqual({ text: "24 days late", late: true });
    expect(f[1].reason.text).toBe("6 days late");
    expect(f[2].reason.text).toBe("Oldest open · 24 days");
  });
  it("names a person with several open, and a meeting that left several", () => {
    const a = [item({ person: "Ana", meetingId: "m2" }), item({ person: "Ana", meetingId: "m2" }), item({ person: "Ana", meetingId: "m2" }), item({ person: "Bo", meetingId: "m1", createdAt: "2026-11-01T00:00:00.000Z" })];
    const f = doFirst(a, ctx);
    expect(f[0].reason.text).toMatch(/^Oldest open/);
    expect(f[1].reason.text).toBe("Ana has 3 open with you");
    expect(f[2].reason.text).toBe("3 open from one meeting");
  });
  it("counts what comes back after tomorrow, per day", () => {
    expect(comingBack(all, ctx)).toEqual([{ date: "2026-12-03", label: "Thu 3 Dec", count: 1 }]);
    expect(todaySets(all, ctx).tomorrow).toHaveLength(1);
  });
  it("lists today's meetings with each line's state and the not-a-promise count", () => {
    const wrong = item({ meetingId: "today", status: "wrong" });
    const c = todaysMeetings([fresh, wrong, item({ meetingId: "today", status: "done", closedAt: now.toISOString(), person: "Jaishil" })], meetings, ctx);
    expect(c).toHaveLength(1);
    expect(c[0].notPromises).toBe(1);
    expect(c[0].rows.map((r) => r.note)).toEqual(["Open · Jit", "Kept · Jaishil"]);
  });
  it("says the day in one sentence and names it", () => {
    expect(daySentence({ meetings: 1, kept: 17, late: 2, tomorrow: 9 })).toBe("One meeting today and 17 promises kept. Two are still late. 9 come back tomorrow.");
    expect(daySentence({ meetings: 0, kept: 0, late: 0, tomorrow: 0 })).toBe("No meetings today. Nothing is late.");
    expect(longDay("2026-11-26")).toBe("Thursday, 26 November");
  });
});

describe("All open and a person", () => {
  const a = item({});
  const b = item({ snoozedUntil: "2026-11-27", person: "Ana" });
  const c = item({ snoozedUntil: "2026-12-03", project: "chart" });
  const d = item({ kind: "decision" });
  it("groups by the day it comes back, open now first", () => {
    const g = openGroups([a, b, c, d], ctx);
    expect(g.map((x) => [x.label, x.short, x.rows.length])).toEqual([["Open now", "Now", 1], ["Back tomorrow", "Tomorrow", 1], ["Back Thu 3 Dec", "Thu 3 Dec", 1]]);
  });
  it("groups by person or project, the unnamed last", () => {
    expect(openGroups([a, b, c], ctx, "person").map((x) => x.label)).toEqual(["Jit", "Ana"]);
    expect(openGroups([a, b, c], ctx, "project", (s) => s.toUpperCase()).map((x) => x.label)).toEqual(["CHART", "No project"]);
  });
  it("a person's groups: you owe, they owe you, decided together, kept", () => {
    const g = personGroups("Jit Kumar", { youOwe: [a], waitingOn: [item({ kind: "waiting" })], decisions: [], closed: [] }, ctx);
    expect(g.map((x) => x.label)).toEqual(["You owe Jit", "Jit owes you"]);
  });
});

describe("projects", () => {
  it("counts each project's open, decisions and kept, most active first", () => {
    const items = [
      item({ project: "chart" }), item({ project: "chart", kind: "waiting" }), item({ project: "chart", kind: "decision" }),
      item({ project: "chart", status: "done" }), item({ project: "tag", meetingId: "m2", person: "Ana" }), item({ project: "tag", status: "wrong" }),
    ];
    const s = projectSummaries([{ slug: "chart", title: "Chart" }, { slug: "tag", title: "Earnings tag" }], items, meetings);
    expect(s.map((p) => p.slug)).toEqual(["tag", "chart"]);
    expect(projectLine(s[1])).toBe("2 open · 1 decision · 1 kept");
    expect(s[0].people).toEqual(["Ana"]);
    expect(s[1].meetings.map((m) => m.id)).toEqual(["m1"]);
  });
});

describe("moving through the list", () => {
  const groups = [{ key: "a", ids: ["1", "2", "3", "4", "5", "6", "7", "8"] }, { key: "b", ids: ["9"] }];
  it("shows six per group until expanded", () => {
    expect(SHOW_LIMIT).toBe(6);
    expect(visibleIds(groups, new Set())).toEqual(["1", "2", "3", "4", "5", "6", "9"]);
    expect(visibleIds(groups, new Set(["a"]))).toHaveLength(9);
  });
  it("opens the group hiding a selected row", () => {
    expect(groupHiding(groups, "8")).toBe("a");
    expect(groupHiding(groups, "2")).toBeNull();
    expect(groupHiding(groups, null)).toBeNull();
  });
  it("steps down and up, stopping at the ends, starting at the top", () => {
    const ids = visibleIds(groups, new Set());
    expect(step(ids, "6", 1)).toBe("9");
    expect(step(ids, "9", 1)).toBe("9");
    expect(step(ids, "1", -1)).toBe("1");
    expect(step(ids, null, 1)).toBe("1");
    expect(step(ids, null, -1)).toBe("9");
    expect(step([], null, 1)).toBeNull();
  });
  it("moves on to the next row when the selected one leaves", () => {
    expect(afterRemoving(["1", "2", "3"], "2")).toBe("3");
    expect(afterRemoving(["1", "2", "3"], "3")).toBe("2");
    expect(afterRemoving(["1"], "1")).toBeNull();
  });
  it("maps keys: j/k and arrows move, e done, s snooze, b block, . menu; c stays quick capture", () => {
    expect(["j", "ArrowDown"].map((k) => keyCommand(k))).toEqual(["next", "next"]);
    expect(["k", "ArrowUp"].map((k) => keyCommand(k))).toEqual(["prev", "prev"]);
    expect(keyCommand("e")).toBe("done");
    expect(keyCommand("d")).toBe("done");
    expect(keyCommand("s")).toBe("snooze");
    expect(keyCommand("b")).toBe("block");
    expect(keyCommand("t")).toBe("start");
    expect(keyCommand("p")).toBe("project");
    expect(keyCommand("f")).toBe("star");
    expect(keyCommand("w")).toBe("wrong");
    expect(keyCommand(".")).toBe("menu");
    expect(keyCommand("c")).toBeNull();
    expect(keyCommand("C", true)).toBe("copy");
    expect(keyCommand("x")).toBeNull();
  });
  it("lands back on the same page with the selection moved and an undo", () => {
    expect(backUrl("/open", "?group=person&item=1", "item", "2")).toBe("/open?group=person&item=2");
    expect(backUrl("/", "?item=1&undo=0&was=done", "item", "2", { id: "1", was: "done" })).toBe("/?item=2&undo=1&was=done");
    expect(backUrl("/", "?item=1", "item", null)).toBe("/");
  });
});
