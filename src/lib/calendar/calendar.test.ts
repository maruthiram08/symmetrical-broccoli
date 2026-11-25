import { describe, expect, it } from "vitest";
import { renderMarkdown } from "@/lib/brief/markdown";
import type { BriefModel, CalendarEvent, Item, Meeting, MeetingSeries } from "@/lib/types";
import { blockFileName, blockIcs, icsText, nextFreeSlot } from "./block";
import { dueHints, dueReference } from "./due";
import { renderTomorrowSection, tomorrowGlance } from "./glance";
import { freshEvents, mergeSeries, nextOccurrence, seriesDetail, seriesPeople } from "./series";

const TZ = "Asia/Kolkata"; // UTC+5:30, no DST
// Wed 25 Nov 2026, 6:00 PM IST
const NOW = new Date("2026-11-25T12:30:00.000Z");

const ev = (id: string, startsAt: string, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({
  calendarId: id, title: `Event ${id}`, startsAt, endsAt: null, attendees: [], ...extra,
});
let n = 0;
const item = (extra: Partial<Item>): Item => ({
  id: `i${++n}`, userId: "u", kind: "owe", text: "Do a thing", person: null, quote: "", meetingId: "m1", dueAt: null,
  status: "open", closedByMeetingId: null, closeQuote: null, createdAt: "2026-11-20T00:00:00.000Z", closedAt: null, ...extra,
});
const mtg = (id: string, providerMeetingId: string, title: string, startedAt: string, participants: string[]): Meeting => ({
  id, userId: "u", providerMeetingId, title, startedAt, participants, processedAt: startedAt,
});

describe("tomorrow at a glance", () => {
  const events = [
    ev("a", "2026-11-26T05:00:00.000Z", { title: "Standup", attendees: ["Arjun Mehta", "maruthi@acme.com", "nitin.kumar@acme.com"] }), // 10:30 AM tomorrow
    ev("b", "2026-11-26T10:00:00.000Z", { title: "Nitin 1:1", attendees: ["Nitin Kumar"] }),
    ev("today", "2026-11-25T13:00:00.000Z", { title: "Late today" }),
    ev("after", "2026-11-26T18:31:00.000Z", { title: "Day after (00:01 IST)" }),
  ];
  const items = [
    item({ id: "owe-arjun", person: "Arjun", text: "Send Arjun the FAQ copy", dueAt: "2026-11-25T08:00:00.000Z" }),
    item({ id: "wait-nitin", kind: "waiting", person: "Nitin", text: "Nitin to send the budget" }),
    item({ id: "done-nitin", person: "Nitin", status: "done" }),
    item({ id: "priya", person: "Priya", text: "Review Priya's flow" }),
  ];

  it("lists only tomorrow's meetings in the user's zone, each with open items with its attendees", () => {
    const g = tomorrowGlance({ events, items, today: "2026-11-25", timeZone: TZ, now: NOW, self: ["Maruthi"] });
    expect(g.map((m) => m.title)).toEqual(["Standup", "Nitin 1:1"]);
    expect(g[0].time).toBe("10:30 AM");
    expect(g[0].people).toEqual(["Arjun Mehta", "Nitin Kumar"]); // you are left out
    expect(g[0].owe.map((x) => x.itemId)).toEqual(["owe-arjun"]);
    expect(g[0].owe[0]).toMatchObject({ late: true, when: "4h late" });
    // Nitin's item is listed once, under the smaller meeting with him (his 1:1)
    expect(g[0].waiting).toEqual([]);
    expect(g[0]).toMatchObject({ alsoOpen: 1, alsoIn: ["Nitin 1:1"] });
    expect(g[1].owe).toEqual([]);
    expect(g[1].waiting.map((x) => x.itemId)).toEqual(["wait-nitin"]);
    expect(g[1].alsoOpen).toBe(0);
  });

  it("links a meeting to its series and renders the note section", () => {
    const series: MeetingSeries[] = [{ id: "s1", title: "Standup", providerMeetingIds: ["p1"] }];
    const g = tomorrowGlance({ events, items, series, today: "2026-11-25", timeZone: TZ, now: NOW, self: ["Maruthi"] });
    expect(g[0].seriesId).toBe("s1");
    const md = renderTomorrowSection(g).join("\n");
    expect(md).toContain("## Tomorrow at a glance");
    expect(md).toContain("- 10:30 AM · Standup (with Arjun Mehta, Nitin Kumar)");
    expect(md).toContain("  - [ ] You owe Arjun: Send Arjun the FAQ copy **(4h late)**");
    expect(md).toContain("  - 1 more with them, under Nitin 1:1");
    expect(md).toContain("- 3:30 PM · Nitin 1:1 (with Nitin Kumar)\n  - [ ] Waiting on Nitin: Nitin to send the budget");
    expect(renderTomorrowSection([])).toEqual(["## Tomorrow at a glance", "", "No meetings tomorrow.", ""]);
    expect(renderTomorrowSection(undefined)).toEqual([]);
  });

  it("goes into the daily note before Wrap only when the model has it", () => {
    const base: BriefModel = {
      userId: "u", date: "2026-11-25", dateLabel: "Wednesday, 25 November", meetingCount: 0,
      wrap: { meetings: 0, made: 0, kept: 0, late: 0 }, youOwe: [], waitingOn: [], decisions: [], closedToday: [],
      stillOpenCount: 0, stillOpen: [], empty: "no_meetings", subject: "s",
    };
    expect(renderMarkdown(base)).not.toContain("Tomorrow");
    const md = renderMarkdown({ ...base, tomorrow: tomorrowGlance({ events, items, today: "2026-11-25", timeZone: TZ, now: NOW }) });
    expect(md.indexOf("## Tomorrow at a glance")).toBeGreaterThan(0);
    expect(md.indexOf("## Tomorrow at a glance")).toBeLessThan(md.indexOf("## Wrap"));
  });
});

describe("meeting series", () => {
  it("merges list_meeting_series answers into one series with a stable id", () => {
    const a = mergeSeries([], { occurrences: [{ providerMeetingId: "p1", title: "Standup", startedAt: "2026-11-24T05:30:00Z" }, { providerMeetingId: "p2", title: "Daily standup", startedAt: "2026-11-25T05:30:00Z" }], recurringId: null });
    expect(a.series).toHaveLength(1);
    expect(a.series[0].title).toBe("Daily standup"); // newest occurrence's title
    const b = mergeSeries(a.series, { occurrences: [{ providerMeetingId: "p3", title: "Daily standup", startedAt: "2026-11-26T05:30:00Z" }, { providerMeetingId: "p2", title: "x", startedAt: "2026-11-25T05:30:00Z" }], recurringId: null });
    expect(b.series).toHaveLength(1);
    expect(b.id).toBe(a.id);
    expect(b.series[0].providerMeetingIds).toEqual(["p1", "p2", "p3"]);
    const c = mergeSeries(b.series, { occurrences: [{ providerMeetingId: "q1", title: "Nitin 1:1", startedAt: null }], recurringId: "rec-9" });
    expect(c.series).toHaveLength(2);
    expect(c.id).not.toBe(a.id);
  });

  it("finds the next occurrence by recurring id, else by title", () => {
    const s: MeetingSeries = { id: "s", title: "Nitin 1:1", providerMeetingIds: [] };
    const events = [
      ev("x", "2026-11-25T10:00:00.000Z", { title: "Nitin 1:1" }), // past
      ev("y", "2026-11-27T10:00:00.000Z", { title: "nitin  1:1" }),
      ev("z", "2026-11-26T10:00:00.000Z", { title: "Something else" }),
    ];
    expect(nextOccurrence(s, events, NOW)?.calendarId).toBe("y");
    expect(nextOccurrence({ ...s, recurringId: "r" }, [...events, ev("w", "2026-11-26T09:00:00.000Z", { title: "Moved", recurringId: "r" })], NOW)?.calendarId).toBe("w");
  });

  it("collects people and per-meeting items newest first for the series page", () => {
    const s: MeetingSeries = { id: "s", title: "Standup", providerMeetingIds: ["p1", "p2"] };
    const meetings = [
      mtg("m1", "p1", "Standup", "2026-11-24T05:30:00.000Z", ["Maruthi", "Arjun Mehta"]),
      mtg("m2", "p2", "Standup", "2026-11-25T05:30:00.000Z", ["Maruthi", "Arjun", "Priya Shah"]),
      mtg("m3", "p9", "Other", "2026-11-25T07:30:00.000Z", ["Leela"]),
    ];
    expect(seriesPeople(s, meetings, ["Maruthi"])).toEqual(["Arjun", "Priya Shah", "Arjun Mehta"]);
    const items = [
      item({ id: "d", kind: "decision", meetingId: "m2" }),
      item({ id: "o", meetingId: "m2" }),
      item({ id: "w", meetingId: "m2", status: "wrong" }),
      item({ id: "k", meetingId: "m1", status: "done" }),
      item({ id: "x", meetingId: "m3" }),
    ];
    const d = seriesDetail(s, { meetings, items, events: [], now: NOW });
    expect(d.meetings.map((m) => m.meeting.id)).toEqual(["m2", "m1"]);
    expect(d.meetings[0].items.map((i) => i.id)).toEqual(["o", "d"]);
    expect(d.counts).toEqual({ open: 1, done: 1, decisions: 1 });
  });

  it("ignores a calendar cache older than a day", () => {
    const cache = { fetchedAt: "2026-11-24T10:00:00.000Z", nextFetchAt: "", fromIso: "", toIso: "", events: [ev("a", "2026-11-26T05:00:00.000Z")], series: [], seriesChecked: {} };
    expect(freshEvents(cache, NOW)).toEqual([]);
    expect(freshEvents({ ...cache, fetchedAt: "2026-11-25T12:00:00.000Z" }, NOW)).toHaveLength(1);
    expect(freshEvents(null, NOW)).toEqual([]);
  });
});

describe("due-date sanity", () => {
  const series: MeetingSeries[] = [
    { id: "standup", title: "Standup", providerMeetingIds: ["p1"] },
    { id: "nitin11", title: "Nitin 1:1", providerMeetingIds: ["p2"] },
    { id: "priya11", title: "Priya 1:1", providerMeetingIds: ["p3"] },
  ];
  const meetings = [
    mtg("m1", "p1", "Standup", "2026-11-25T05:30:00.000Z", ["Maruthi", "Arjun Mehta", "Nitin Kumar", "Priya Shah"]),
    mtg("m2", "p2", "Nitin 1:1", "2026-11-24T11:30:00.000Z", ["Maruthi", "Nitin Kumar"]),
    mtg("m3", "p3", "Priya 1:1", "2026-11-23T11:30:00.000Z", ["Maruthi", "Priya Shah"]),
  ];
  const events = [
    ev("su", "2026-11-26T05:00:00.000Z", { title: "Standup" }),
    ev("n11", "2026-11-27T11:30:00.000Z", { title: "Nitin 1:1" }),
    // Priya's 1:1 has no next meeting on the calendar
  ];
  const hints = (items: Item[]) => dueHints({ items, series, meetings, events, now: NOW, self: ["Maruthi"] });

  it("reads 'before the next standup' as the series' next meeting", () => {
    expect(dueReference("Send it before the next standup", series)).toMatchObject({ kind: "named", series: [{ id: "standup" }] });
    expect(dueReference("by our next stand-up", series)).toMatchObject({ kind: "named" });
    expect(dueReference("I'll have it for the next 1:1 with Nitin", series)).toMatchObject({ kind: "named" });
    expect(dueReference("next time we meet", series)).toEqual({ kind: "generic" });
    expect(dueReference("next week", series)).toBeNull();
    expect(dueReference("the next Friday", series)).toBeNull();
    const h = hints([item({ id: "a", person: "Arjun", quote: "I'll send it before the next standup", dueAt: "2026-11-27T12:30:00.000Z" })]);
    expect(h.get("a")).toMatchObject({ dueAt: "2026-11-26T05:00:00.000Z", seriesId: "standup", reason: "named" });
  });

  it("picks the 1:1 of the item's person when '1:1' is ambiguous", () => {
    const h = hints([item({ id: "a", person: "Nitin", quote: "I'll bring it to our next 1:1" })]);
    expect(h.get("a")?.seriesId).toBe("nitin11");
  });

  it("suggests the smallest series with the person when there's no due", () => {
    const h = hints([
      item({ id: "nitin", person: "Nitin", text: "Share the hiring plan with Nitin" }),
      item({ id: "arjun", person: "Arjun", text: "Write the FAQ" }),
      item({ id: "priya", person: "Priya", text: "Review the flow" }), // her 1:1 isn't scheduled: standup it is
      item({ id: "leela", person: "Leela", text: "Ask Leela" }), // no series with Leela
    ]);
    expect(h.get("nitin")).toMatchObject({ seriesId: "nitin11", reason: "person", dueAt: "2026-11-27T11:30:00.000Z" });
    expect(h.get("arjun")?.seriesId).toBe("standup");
    expect(h.get("priya")?.seriesId).toBe("standup");
    expect(h.has("leela")).toBe(false);
  });

  it("leaves items with a due date, closed items and decisions alone, and skips a due that's already right", () => {
    const h = hints([
      item({ id: "dated", person: "Nitin", dueAt: "2026-11-30T12:00:00.000Z" }),
      item({ id: "done", person: "Nitin", status: "done" }),
      item({ id: "dec", kind: "decision", person: null, quote: "before the next standup" }),
      item({ id: "right", person: "Arjun", quote: "before the next standup", dueAt: "2026-11-26T05:30:00.000Z" }),
    ]);
    expect([...h.keys()]).toEqual([]);
  });

  it("suggests nothing without a calendar", () => {
    expect(dueHints({ items: [item({ person: "Nitin" })], series, meetings, events: [], now: NOW }).size).toBe(0);
  });
});

describe("block time", () => {
  it("finds the next free half hour in 10-19 local, around cached events", () => {
    // 6:00 PM IST now: 6:15-6:45 is free today
    expect(nextFreeSlot([], NOW, TZ)?.start.toISOString()).toBe("2026-11-25T12:45:00.000Z");
    // a meeting 6:00-7:00 PM pushes it to tomorrow 10:00 AM IST
    const busy = [ev("e", "2026-11-25T12:30:00.000Z", { endsAt: "2026-11-25T13:30:00.000Z" })];
    expect(nextFreeSlot(busy, NOW, TZ)?.start.toISOString()).toBe("2026-11-26T04:30:00.000Z");
    // tomorrow 10:00-10:30 busy and 10:30 with no end (30 min): 11:00 AM
    const more = [...busy, ev("f", "2026-11-26T04:30:00.000Z", { endsAt: "2026-11-26T05:00:00.000Z" }), ev("g", "2026-11-26T05:00:00.000Z")];
    expect(nextFreeSlot(more, NOW, TZ)?.start.toISOString()).toBe("2026-11-26T05:30:00.000Z");
    // an event ending at :40 starts the slot at the next quarter hour
    const odd = [...busy, ev("h", "2026-11-26T04:30:00.000Z", { endsAt: "2026-11-26T05:10:00.000Z" })];
    expect(nextFreeSlot(odd, NOW, TZ)?.start.toISOString()).toBe("2026-11-26T05:15:00.000Z");
  });

  it("skips weekends and the hours outside work", () => {
    // Fri 27 Nov 2026, 7:30 PM IST -> Mon 30 Nov, 10:00 AM IST
    expect(nextFreeSlot([], new Date("2026-11-27T14:00:00.000Z"), TZ)?.start.toISOString()).toBe("2026-11-30T04:30:00.000Z");
    // 7:00 AM IST -> 10:00 AM IST the same day
    expect(nextFreeSlot([], new Date("2026-11-25T01:30:00.000Z"), TZ)?.start.toISOString()).toBe("2026-11-25T04:30:00.000Z");
    // works in another zone: 9:00 AM New York -> 10:00 AM New York
    expect(nextFreeSlot([], new Date("2026-11-25T14:00:00.000Z"), "America/New_York")?.start.toISOString()).toBe("2026-11-25T15:00:00.000Z");
  });

  it("returns null when every working slot is taken", () => {
    const allDay = [ev("x", "2026-11-25T00:00:00.000Z", { endsAt: "2026-12-31T00:00:00.000Z" })];
    expect(nextFreeSlot(allDay, NOW, TZ)).toBeNull();
  });

  it("writes a valid one-event .ics with escaped, folded text", () => {
    const ics = blockIcs({
      uid: "i1@daily-brief.local", title: "Send Arjun the copy; FAQ, v2", description: "x".repeat(120),
      start: new Date("2026-11-26T04:30:00.000Z"), end: new Date("2026-11-26T05:00:00.000Z"), now: NOW,
    });
    expect(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n")).toBe(true);
    expect(ics).toContain("DTSTART:20261126T043000Z\r\n");
    expect(ics).toContain("DTEND:20261126T050000Z\r\n");
    expect(ics).toContain("DTSTAMP:20261125T123000Z\r\n");
    expect(ics).toContain("SUMMARY:Send Arjun the copy\\; FAQ\\, v2\r\n");
    expect(ics.split("\r\n").every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
    expect(ics).toContain("\r\n x"); // folded
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(icsText("a\\b\nc")).toBe("a\\\\b\\nc");
    expect(blockFileName("Send Arjun the banner copy for the FAQ!")).toBe("block-send-arjun-the-banner-copy-for-the-faq.ics");
  });
});
