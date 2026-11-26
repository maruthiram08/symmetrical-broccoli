import { describe, expect, it } from "vitest";
import type { Item, Meeting } from "@/lib/types";
import { meetingsSince, metGroups, metLede, metLine, sinceLabel, updateTemplate } from "./met";

const now = new Date("2026-11-26T12:00:00.000Z");
const meeting = (id: string, day: string): Meeting => ({ id, userId: "u", providerMeetingId: id, title: `M ${id}`, startedAt: `2026-11-${day}T10:00:00.000Z`, participants: [], processedAt: null });
const meetings = ["01", "03", "05", "08", "12", "20", "25"].map((d) => meeting(`m${d}`, d));
let n = 0;
const item = (person: string, meetingId: string, o: Partial<Item> = {}): Item => ({
  id: `i${++n}`, userId: "u", kind: "owe", text: `Thing ${n}`, person, quote: "", meetingId, dueAt: null, status: "open",
  closedByMeetingId: null, closeQuote: null, createdAt: "2026-11-26T00:00:00.000Z", closedAt: null, ...o,
});
const items = [
  // Jit: open from 1 Nov, met on 5, 12 and 25 since (the 25th twice: one meeting).
  item("Jit", "m01"), item("Jit", "m05", { status: "done" }), item("Jit", "m12", { kind: "decision" }), item("Jit", "m25"), item("Jit", "m25"),
  // Aman: one open from 3 Nov, never met since.
  item("Aman", "m03"),
  // Nikhil: open from 20 Nov, no meeting since, but recent.
  item("Nikhil", "m20"),
  // Poonam: nothing open.
  item("Poonam", "m08", { status: "done" }),
];
const short = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

describe("people by meetings since", () => {
  const g = metGroups({ items, meetings, now }, "UTC");
  it("puts someone you kept meeting in Met since, the silent in Gone quiet, the recent in This week, and skips nothing-open", () => {
    expect(g.since.map((p) => p.person.name)).toEqual(["Jit"]);
    expect(g.quiet.map((p) => p.person.name)).toEqual(["Aman"]);
    expect(g.week.map((p) => p.person.name)).toEqual(["Nikhil"]);
  });
  it("counts distinct meetings after the item's meeting", () => {
    const jit = g.since[0];
    expect(jit.sinceOldest).toBe(3);
    expect(meetingsSince(jit.open[1], jit.met, new Map(meetings.map((m) => [m.id, m])))).toHaveLength(0);
  });
  it("words the rows and the lede", () => {
    expect(metLine(g.since[0], short)).toBe("3 open · met 3 times since the oldest");
    expect(metLine(g.quiet[0], short)).toBe("1 open · last met 3 Nov");
    expect(metLine(g.week[0], short)).toBe("1 open · from 20 Nov");
    expect(metLede(g.since[0], short)).toBe("You've been in 4 meetings with Jit since 1 Nov. You kept 1 promise and 3 are open. The oldest has sat through 3 meetings without being closed.");
    expect(sinceLabel(0, null)).toBe("Not met since");
    expect(sinceLabel(5, 24)).toBe("5 since · 24d late");
  });
  it("drafts an update asking about the oldest", () => {
    const t = updateTemplate("Jit Kumar", g.since[0].open);
    expect(t.split("\n")[0]).toBe("Hi Jit, a quick status on what I owe you:");
    expect(t).toContain("thing 1: not started. Still needed, or drop it?");
  });
});
