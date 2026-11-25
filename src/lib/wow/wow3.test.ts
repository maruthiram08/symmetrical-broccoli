import { describe, expect, it } from "vitest";
import type { Item, Meeting } from "@/lib/types";
import { personCard, waitingOnYou, waitingPhrase } from "./person-card";
import { overlap, quietStreak, relatedItems, streakNote, timeline } from "./timeline";

const TZ = "Asia/Kolkata";
const U = "u1";
const mtg = (id: string, startedAt: string, extra: Partial<Meeting> = {}): Meeting => ({
  id, userId: U, providerMeetingId: `p-${id}`, title: `Meeting ${id}`, startedAt, participants: [], processedAt: startedAt, ...extra,
});
let n = 0;
const item = (meetingId: string, kind: Item["kind"], extra: Partial<Item> = {}): Item => ({
  id: `i${++n}`, userId: U, kind, text: `Item ${n}`, person: null, quote: "q", meetingId, dueAt: null, status: "open",
  closedByMeetingId: null, closeQuote: null, createdAt: "2026-11-20T00:00:00.000Z", closedAt: null, ...extra,
});
const now = new Date("2026-11-25T08:30:00.000Z");
const self = ["Maruthi", "Maru"];

describe("person card", () => {
  const meetings = [mtg("a", "2026-11-19T05:00:00.000Z"), mtg("b", "2026-11-24T05:00:00.000Z", { participants: ["Nitin Kumar"] }), mtg("c", "2026-11-25T05:00:00.000Z")];
  const items = [
    item("b", "owe", { id: "o2", person: "Nitin", text: "Send the deck" }),
    item("a", "owe", { id: "o1", person: "Nitin K", text: "Send banner copy", dueAt: "2026-11-20T10:00:00.000Z" }),
    item("a", "waiting", { id: "w1", person: "nitin", text: "Nitin to share numbers" }),
    item("a", "owe", { id: "x", person: "Nitin", status: "wrong" }),
    item("a", "owe", { id: "d", person: "Nitin", status: "done" }),
    item("c", "owe", { id: "p", person: "Priya" }),
  ];
  it("shows what you owe them (oldest first, late flagged), what they owe you, and the last meeting", () => {
    const c = personCard("nitin-k", { items, meetings, now, self })!;
    expect(c.name).toBe("Nitin");
    expect(c.youOwe.map((i) => [i.id, i.late])).toEqual([["o1", true], ["o2", false]]);
    expect(c.youOweCount).toBe(2);
    expect(c.theyOwe.map((i) => i.id)).toEqual(["w1"]);
    expect(c.lastMeeting?.id).toBe("b");
  });
  it("is null for someone unknown", () => {
    expect(personCard("nobody", { items, meetings, now, self })).toBeNull();
  });
  it("ranks who's waiting on you by count, then age, and words it plainly", () => {
    const w = waitingOnYou({ items, meetings, now, self });
    expect(w.map((p) => [p.name, p.count, p.oldestDays])).toEqual([["Nitin", 2, 6], ["Priya", 1, 0]]);
    expect(waitingPhrase(w[0])).toBe("Nitin is waiting on 2 things, oldest 6 days");
    expect(waitingPhrase(w[1])).toBe("Priya is waiting on 1 thing, from today");
    expect(waitingPhrase({ ...w[1], oldestDays: 3 })).toBe("Priya is waiting on 1 thing, 3 days old");
  });
  it("leaves out your own name", () => {
    expect(waitingOnYou({ items: [item("a", "owe", { person: "Maru" })], meetings, now, self })).toEqual([]);
  });
});

describe("timeline", () => {
  const meetings = [
    mtg("m1", "2026-11-16T06:30:00.000Z", { title: "Banner sync" }),
    mtg("m2", "2026-11-19T10:30:00.000Z", { title: "Standup" }),
    mtg("m3", "2026-11-24T11:30:00.000Z", { title: "Review" }),
  ];
  const made = item("m1", "owe", { id: "t1", person: "Nitin", text: "Send Nitin the final banner text", quote: "I'll send you the final banner copy tonight", dueAt: "2026-11-17T16:30:00.000Z" });
  const again = item("m2", "owe", { id: "t2", person: "Nitin", text: "Send Nitin the banner text", quote: "banner copy still pending" });
  const other = item("m2", "owe", { id: "t3", person: "Priya", text: "Send Priya the banner text" });
  it("tells the life of a promise closed by a later meeting", () => {
    const done = { ...made, status: "done" as const, closedByMeetingId: "m3", closeQuote: "Got the banner text, thanks", closedAt: "2026-11-24T12:00:00.000Z" };
    const ev = timeline(done, [done, again, other], meetings, now, self);
    expect(ev.map((e) => e.kind)).toEqual(["made", "due", "mentioned", "closed"]);
    expect(ev[0]).toMatchObject({ quote: done.quote, meeting: { title: "Banner sync" } });
    expect(ev[1]).toMatchObject({ passed: true });
    expect(ev[2]).toMatchObject({ itemId: "t2" });
    expect(ev[3]).toMatchObject({ quote: "Got the banner text, thanks", meeting: { title: "Review" } });
  });
  it("ends with your mark, or 'still open'", () => {
    const marked = { ...made, status: "done" as const, closedAt: "2026-11-18T00:00:00.000Z" };
    expect(timeline(marked, [marked], meetings, now).at(-1)).toMatchObject({ kind: "marked", status: "done" });
    expect(timeline(made, [made], meetings, now).at(-1)).toMatchObject({ kind: "open" });
  });
  it("doesn't count mentions after it closed, or in the same meeting", () => {
    const closedEarly = { ...made, status: "done" as const, closedAt: "2026-11-18T00:00:00.000Z" };
    expect(timeline(closedEarly, [closedEarly, again], meetings, now).some((e) => e.kind === "mentioned")).toBe(false);
    const same = { ...again, id: "t4", meetingId: "m1" };
    expect(timeline(made, [made, same], meetings, now).some((e) => e.kind === "mentioned")).toBe(false);
  });
});

describe("related past items", () => {
  const meetings = [mtg("m1", "2026-11-16T06:30:00.000Z"), mtg("m2", "2026-11-19T10:30:00.000Z"), mtg("m3", "2026-11-24T11:30:00.000Z")];
  const target = item("m3", "owe", { id: "r0", person: "Nitin", text: "Send Nitin the dividend banner mockups", quote: "mockups by Friday" });
  const items = [
    target,
    item("m1", "decision", { id: "r1", text: "Ship the dividend banner without animation", quote: "drop the animation" }),
    item("m2", "waiting", { id: "r2", person: "Nitin K", text: "Nitin to review pricing", quote: "I'll review pricing" }),
    item("m2", "owe", { id: "r3", person: "Priya", text: "Book the venue", quote: "I'll book it" }),
    item("m1", "owe", { id: "r4", person: "Nitin", text: "Banner mockups first draft", quote: "draft mockups", status: "wrong" }),
    item("m3", "owe", { id: "later", person: "Nitin", text: "Dividend banner mockups v2", quote: "v2 mockups" }),
  ];
  it("finds earlier items by word overlap or the same person, skips unrelated, wrong and later ones", () => {
    const r = relatedItems({ ...target, meetingId: "m3" }, items.map((i) => (i.id === "later" ? { ...i, meetingId: "m4" } : i)), [...meetings, mtg("m4", "2026-11-25T05:00:00.000Z")], self);
    expect(r.map((x) => x.item.id).sort()).toEqual(["r1", "r2"]);
    expect(r.find((x) => x.item.id === "r1")!.why).toContain("banner");
  });
  it("returns at most 3", () => {
    const many = Array.from({ length: 6 }, (_, k) => item("m1", "decision", { text: `Dividend banner choice ${k}` }));
    expect(relatedItems(target, [target, ...many], meetings).length).toBe(3);
  });
  it("overlap ignores common words", () => {
    expect(overlap("Send the deck to them", "send it to them today")).toBe(0);
    expect(overlap("banner mockups", "mockups banner")).toBe(1);
  });
});

describe("quiet streak", () => {
  const meetings = [mtg("m1", "2026-11-16T06:30:00.000Z")];
  it("counts days back from today with nothing overdue", () => {
    // due 17 Nov 10 PM local, closed 20 Nov 6 PM local: overdue 17..20 Nov. Quiet 21..25 = 5 days.
    const closed = item("m1", "owe", { dueAt: "2026-11-17T16:30:00.000Z", status: "done", closedAt: "2026-11-20T12:30:00.000Z" });
    expect(quietStreak([closed], meetings, now, TZ)).toBe(5);
    expect(streakNote(5)).toBe("Nothing overdue for 5 days.");
    expect(streakNote(2)).toBeNull();
  });
  it("is 0 while something is overdue, and ignores wrong items and decisions", () => {
    const late = item("m1", "waiting", { dueAt: "2026-11-24T00:00:00.000Z" });
    expect(quietStreak([late], meetings, now, TZ)).toBe(0);
    expect(quietStreak([{ ...late, status: "wrong" }, item("m1", "decision", { dueAt: "2026-11-20T00:00:00.000Z" })], meetings, now, TZ)).toBe(10);
  });
  it("never counts before the first meeting", () => {
    expect(quietStreak([], [mtg("m", "2026-11-24T05:00:00.000Z")], now, TZ)).toBe(2);
    expect(quietStreak([], [], now, TZ)).toBe(0);
  });
});
