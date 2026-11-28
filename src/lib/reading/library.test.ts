import { describe, expect, it } from "vitest";
import type { Item, Meeting } from "@/lib/types";
import {
  cadenceOf, countBy, dayBadge, dayLede, dayLine, dayParts, editedLabel, groupNotes, itemLine, monthBounds, monthName, noteGroupOf,
  periodStats, prevMonth, seriesCounts, settingsSection, weekGroups,
} from "./library";
import type { Ctx } from "./model";

const now = new Date("2026-11-26T18:00:00.000Z");
const tz = "Europe/London";
const meeting = (id: string, startedAt: string, title = `Meeting ${id}`): Meeting => ({ id, userId: "u", providerMeetingId: id, title, startedAt, participants: [], processedAt: startedAt });
const meetings = [meeting("a", "2026-11-26T11:00:00.000Z", "MVP Banner"), meeting("b", "2026-11-25T11:00:00.000Z", "Dividend"), meeting("c", "2026-11-24T11:00:00.000Z"), meeting("d", "2026-11-19T11:00:00.000Z")];
const ctx: Ctx = { meetings: new Map(meetings.map((m) => [m.id, m])), timeZone: tz, now };
let n = 0;
const item = (o: Partial<Item>): Item => ({
  id: `i${++n}`, userId: "u", kind: "owe", text: `Item ${n}`, person: "Jit", quote: "I'll do it.", meetingId: "a", dueAt: null, status: "open",
  closedByMeetingId: null, closeQuote: null, createdAt: "2026-11-26T12:00:00.000Z", closedAt: null, ...o,
});

describe("daily briefs", () => {
  it("groups days into this week, last week and earlier, newest first, leaving out empty groups", () => {
    const g = weekGroups(["2026-11-24", "2026-11-26", "2026-11-19", "2026-11-03", "2026-11-26"], "2026-11-26");
    expect(g.map((x) => [x.key, x.dates])).toEqual([["week", ["2026-11-26", "2026-11-24"]], ["last", ["2026-11-19"]], ["earlier", ["2026-11-03"]]]);
    expect(weekGroups([], "2026-11-26")).toEqual([]);
  });
  it("badges today, a weekday this fortnight, and a date before", () => {
    expect(dayBadge("2026-11-26", "2026-11-26")).toBe("Today");
    expect(dayBadge("2026-11-19", "2026-11-26")).toBe("Thu");
    expect(dayBadge("2026-11-03", "2026-11-26")).toBe("3 Nov");
  });
  it("splits a day into new promises, decisions and (today) late, and says it in a line", () => {
    const items = [item({}), item({ kind: "decision" }), item({ status: "wrong" }), item({ meetingId: "d", dueAt: "2026-11-20T10:00:00.000Z" })];
    const p = dayParts("2026-11-26", items, meetings, ctx);
    expect(p.meetings.map((m) => m.id)).toEqual(["a"]);
    expect(p.owe).toHaveLength(1);
    expect(p.decisions).toHaveLength(1);
    expect(p.late).toHaveLength(1);
    expect(dayLine(p, true)).toBe("1 meeting · 1 new · 1 decision · 1 late");
    expect(dayLede(p)).toBe("1 meeting. 1 new, 1 decided, 1 late.");
    const before = dayParts("2026-11-25", items, meetings, ctx);
    expect(before.late).toEqual([]);
    expect(dayLine(before, false)).toBe("1 meeting · Dividend");
  });
});

describe("rows and numbers", () => {
  it("turns an item into a compact row with meeting · person under it", () => {
    expect(itemLine(item({ text: "Ship it" }), ctx, "/item/x")).toMatchObject({ title: "Ship it", small: "MVP Banner · Jit", mark: "owe", href: "/item/x" });
    expect(itemLine(item({ quote: "Yes" }), ctx, "/x", { small: "quote" }).small).toBe("“Yes”");
  });
  it("counts a period: made, kept, open, wrong, decisions and the kept rate", () => {
    const items = [item({ status: "done" }), item({}), item({ status: "wrong" }), item({ kind: "decision" }), item({ meetingId: "d" })];
    expect(periodStats(items, meetings, ctx, "2026-11-24", "2026-11-26")).toEqual({ meetings: 3, made: 3, kept: 1, open: 1, wrong: 1, decisions: 1, rate: 33 });
  });
  it("counts by key, most first", () => {
    expect(countBy(["a", "b", "a", null], (x) => x)).toEqual([["a", 2], ["b", 1]]);
  });
  it("names months and their bounds", () => {
    expect(monthName("2026-11")).toBe("November 2026");
    expect(monthBounds("2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(prevMonth("2026-01")).toBe("2025-12");
  });
});

describe("recurring", () => {
  it("counts a series' open, kept and decided", () => {
    expect(seriesCounts([meetings[0]], [item({}), item({ status: "done" }), item({ kind: "decision" }), item({ meetingId: "b" })])).toEqual({ open: 1, kept: 1, decisions: 1 });
  });
  it("says how often it happens", () => {
    expect(cadenceOf(meetings.slice(0, 3), tz)).toBe("Most weekdays");
    expect(cadenceOf([meetings[0], meetings[3]], tz)).toBe("About weekly");
    expect(cadenceOf([meetings[0]], tz)).toBe("Once so far");
  });
});

describe("notes", () => {
  it("groups notes as projects, people, meetings, daily and other", () => {
    expect(noteGroupOf({ path: "notes/chart.md", title: "Chart", type: "Project", updatedAt: null })).toBe("projects");
    expect(noteGroupOf({ path: "people/Jit.md", title: "Jit", type: null, updatedAt: null })).toBe("people");
    expect(noteGroupOf({ path: "2026-11-26.md", title: "2026-11-26", type: null, updatedAt: null })).toBe("daily");
    expect(noteGroupOf({ path: "notes/plan.md", title: "Plan", type: null, updatedAt: null })).toBe("other");
    const g = groupNotes([{ path: "a.md", title: "A", type: null, updatedAt: "2026-11-01" }, { path: "p.md", title: "P", type: "project", updatedAt: null }]);
    expect(g.map((x) => x.key)).toEqual(["projects", "other"]);
  });
  it("says when a note was edited", () => {
    expect(editedLabel("2026-11-26T10:00:00.000Z", ctx)).toBe("edited today");
    expect(editedLabel("2026-11-20T10:00:00.000Z", ctx)).toBe("edited 20 Nov");
  });
});

describe("settings", () => {
  it("opens the section asked for, or the one a redirect came back for", () => {
    expect(settingsSection({ section: "ai" })).toBe("ai");
    expect(settingsSection({ section: "nope" })).toBe("you");
    expect(settingsSection({ integ: "jira" })).toBe("tools");
    expect(settingsSection({ upload: "ok" })).toBe("meetings");
    expect(settingsSection({ ch: "slack" })).toBe("delivery");
    expect(settingsSection({ sync: "bad" })).toBe("sync");
    expect(settingsSection({ model: "bad" })).toBe("access");
    expect(settingsSection({})).toBe("you");
  });
});
