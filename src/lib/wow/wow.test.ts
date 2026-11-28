import { describe, expect, it } from "vitest";
import type { Item, Meeting, UpcomingMeeting } from "@/lib/types";
import { buildRibbon } from "./ribbon";
import { attendeeName, nextUpcoming, prepFor, prepNotice } from "./prep";

const TZ = "Asia/Kolkata"; // +05:30
const U = "u1";
const mtg = (id: string, startedAt: string, extra: Partial<Meeting> = {}): Meeting => ({
  id, userId: U, providerMeetingId: `p-${id}`, title: `Meeting ${id}`, startedAt, participants: [], processedAt: startedAt, ...extra,
});
let n = 0;
const item = (meetingId: string, kind: Item["kind"], extra: Partial<Item> = {}): Item => ({
  id: `i${++n}`, userId: U, kind, text: `Item ${n}`, person: null, quote: "q", meetingId, dueAt: null, status: "open",
  closedByMeetingId: null, closeQuote: null, createdAt: "2026-11-25T00:00:00.000Z", closedAt: null, ...extra,
});

describe("day ribbon", () => {
  const now = new Date("2026-11-25T08:30:00.000Z"); // 2 PM local
  it("groups items by meeting, skips wrong ones, and lays today out between 9 and 6", () => {
    const meetings = [
      mtg("b", "2026-11-25T07:30:00.000Z"), // 1 PM
      mtg("a", "2026-11-25T03:30:00.000Z"), // 9 AM
      mtg("y", "2026-11-24T10:00:00.000Z"), // yesterday: left out
      mtg("c", "2026-11-25T09:30:00.000Z", { processedAt: null }), // 3 PM, not read yet
    ];
    const items = [
      item("a", "owe"), item("a", "waiting"), item("a", "decision"), item("a", "owe", { status: "wrong" }),
      item("b", "waiting"), item("b", "owe", { status: "done" }),
    ];
    const r = buildRibbon({ date: "2026-11-25", timeZone: TZ, meetings, items, now });
    expect(r.fromHour).toBe(9);
    expect(r.toHour).toBe(18);
    expect(r.meetings.map((m) => [m.id, m.owe, m.waiting, m.decisions, m.total, m.pending])).toEqual([
      ["a", 1, 1, 1, 3, false],
      ["b", 1, 1, 0, 2, false],
      ["c", 0, 0, 0, 0, true],
    ]);
    expect(r.meetings[0].at).toBe(0);
    expect(r.meetings[1].at).toBeCloseTo(4 / 9);
    expect(r.meetings[0].time).toBe("9:00 AM");
    expect(r.now).toBeCloseTo(5 / 9);
    expect(r.ticks.map((t) => t.label)).toEqual(["9a", "12p", "3p", "6p"]);
  });
  it("widens the day for early and late meetings", () => {
    const r = buildRibbon({
      date: "2026-11-25", timeZone: TZ, items: [], now,
      meetings: [mtg("e", "2026-11-25T01:30:00.000Z"), mtg("l", "2026-11-25T15:45:00.000Z")], // 7 AM, 9:15 PM
    });
    expect([r.fromHour, r.toHour]).toEqual([7, 22]);
    expect(r.meetings[1].at).toBeLessThan(1);
  });
  it("is empty with no meetings, and has no now marker on another day", () => {
    const r = buildRibbon({ date: "2026-11-24", timeZone: TZ, meetings: [], items: [], now });
    expect(r.meetings).toEqual([]);
    expect(r.now).toBeNull();
  });
});

describe("prep", () => {
  const up = (attendees: string[], startsAt = "2026-11-25T09:00:00.000Z"): UpcomingMeeting => ({ calendarId: "cal1", title: "Design crit", startsAt, attendees });
  const items = [
    item("a", "owe", { person: "Nitin", text: "Send Nitin the banner" }),
    item("a", "waiting", { person: "Priya", text: "Priya shares the deck", dueAt: "2026-11-25T06:00:00.000Z" }),
    item("a", "waiting", { person: "Arjun Mehta", text: "Arjun sends numbers" }),
    item("a", "owe", { person: "Nitin", status: "done" }),
    item("a", "decision", { person: "Nitin" }),
    item("a", "owe", { person: "Leela" }),
  ];

  it("matches item people to attendees with the People grouping, including emails", () => {
    const p = prepFor(up(["Maruthi", "Nitin Kumar", "priya.shah@acme.com", "arjun@acme.com"]), items, ["Maruthi", "Maru"]);
    expect(p.people).toEqual(["Nitin Kumar", "Priya Shah", "Arjun"]);
    expect(p.owe.map((i) => i.text)).toEqual(["Send Nitin the banner"]);
    // "arjun" (one word) joins "Arjun Mehta" because only one Arjun is known.
    expect(p.waiting.map((i) => i.text)).toEqual(["Priya shares the deck", "Arjun sends numbers"]);
    expect(prepNotice(p)).toBe("With Nitin Kumar, Priya Shah, Arjun: 1 you owe, 2 waiting");
  });
  it("does not match a different person with the same first name", () => {
    const p = prepFor(up(["Nitin Rao"]), [item("a", "owe", { person: "Nitin Kumar" })]);
    expect(p.owe).toEqual([]);
    expect(prepNotice(p)).toBe("With Nitin Rao: nothing open");
  });
  it("leaves the user out and handles a meeting with only you", () => {
    const p = prepFor(up(["Maruthi"]), items, ["Maruthi"]);
    expect(p.people).toEqual([]);
    expect(p.owe).toEqual([]);
  });
  it("picks the next meeting inside the window only", () => {
    const now = new Date("2026-11-25T08:30:00.000Z");
    const list = [up([], "2026-11-25T09:45:00.000Z"), up([], "2026-11-25T08:00:00.000Z"), { ...up([], "2026-11-25T09:10:00.000Z"), calendarId: "soon" }];
    expect(nextUpcoming(list, now)?.calendarId).toBe("soon");
    expect(nextUpcoming(list, now, 30)).toBeNull();
    expect(attendeeName("leela.r@x.io")).toBe("Leela R");
  });
});
