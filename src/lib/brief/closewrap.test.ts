import { describe, expect, it } from "vitest";
import { MemoryStore } from "@/server/store";
import { buildBrief } from "./build";
import { loadBriefData } from "./data";
import { closedSince, LOOK_SESSION_MINUTES, nextLook } from "./looked";
import { renderMarkdown } from "./markdown";
import { buildWeek, isoWeek, isRecapDay, renderWeekMarkdown, weekRangeLabel } from "./week";
import { buildWrap } from "./wrap";

const TZ = "Asia/Kolkata";
const now = new Date("2026-11-25T12:12:00Z"); // Wed 5:42 PM IST

async function seed() {
  const s = new MemoryStore();
  const user = s.addUser({ email: "m@example.com", name: "Maruthi", timeZone: TZ });
  const meet = async (pid: string, title: string, startedAt: string) =>
    (await s.upsertMeeting({ userId: user.id, providerMeetingId: pid, title, startedAt, participants: [] })).meeting;
  const add = async (meetingId: string, at: string, items: Array<{ kind: "owe" | "waiting" | "decision"; text: string; dueAt?: string; person?: string }>, closes: Array<{ itemId: string; quote: string }> = []) =>
    s.commitExtraction({
      meetingId, userId: user.id, at, closes,
      newItems: items.map((i) => ({ kind: i.kind, text: i.text, person: i.person ?? null, quote: `quote for ${i.text}`, meetingId, dueAt: i.dueAt ?? null })),
    });
  const item = (text: string) => [...s.items.values()].find((i) => i.text === text)!;
  return { s, user, meet, add, item };
}

/** A week of meetings: an old promise, Monday planning, Wednesday standup that closes things. */
async function week() {
  const t = await seed();
  const { meet, add, item } = t;
  const old = await meet("m0", "Kickoff", "2026-11-12T05:00:00Z"); // Thu 12 Nov
  await add(old.id, "2026-11-12T06:00:00Z", [
    { kind: "owe", text: "Write the launch FAQ", person: "Asha" },
    { kind: "waiting", text: "Tarun confirms timeline", person: "Tarun" },
  ]);
  const mon = await meet("m1", "Planning", "2026-11-23T05:30:00Z"); // Mon 11:00 AM
  await add(mon.id, "2026-11-23T06:00:00Z", [
    { kind: "owe", text: "Send Nitin the banner text", person: "Nitin", dueAt: "2026-11-24T12:30:00Z" },
    { kind: "owe", text: "Share the deck with Nitin", person: "Nitin" },
    { kind: "decision", text: "Ship the banner on Friday" },
  ]);
  const wed = await meet("m2", "Standup", "2026-11-25T05:30:00Z"); // Wed 11:00 AM
  await add(wed.id, "2026-11-25T06:00:00Z", [
    { kind: "owe", text: "Review the copy", person: "Asha", dueAt: "2026-11-25T09:30:00Z" },
    { kind: "waiting", text: "Asha sends numbers", person: "Asha" },
    { kind: "decision", text: "Move the review to Thursday" },
  ], [
    { itemId: item("Tarun confirms timeline").id, quote: "timeline is fine for Friday" },
    { itemId: item("Send Nitin the banner text").id, quote: "Got the banner text" },
  ]);
  return t;
}

describe("nextLook", () => {
  it("first look has nothing to compare with", () => {
    expect(nextLook(null, now)).toEqual({ since: null, freshAfter: null, next: { lastLookedAt: now.toISOString(), since: null } });
  });
  it("a look after a gap starts from the last look", () => {
    const prev = { lastLookedAt: "2026-11-25T04:00:00.000Z", since: "2026-11-24T04:00:00.000Z" };
    expect(nextLook(prev, now)).toEqual({ since: prev.lastLookedAt, freshAfter: prev.lastLookedAt, next: { lastLookedAt: now.toISOString(), since: prev.lastLookedAt } });
  });
  it("a refresh within the same look keeps the group but only highlights newer closes", () => {
    const prev = { lastLookedAt: new Date(now.getTime() - (LOOK_SESSION_MINUTES - 1) * 60000).toISOString(), since: "2026-11-25T04:00:00.000Z" };
    const l = nextLook(prev, now);
    expect(l.since).toBe("2026-11-25T04:00:00.000Z");
    expect(l.freshAfter).toBe(prev.lastLookedAt);
    expect(l.next.since).toBe("2026-11-25T04:00:00.000Z");
  });
});

describe("closedSince", () => {
  it("lists closes by a later meeting after the last look, newest first, with who said it", async () => {
    const { s, user } = await week();
    const data = await loadBriefData(s, user.id);
    const lines = closedSince(data, { since: "2026-11-25T05:00:00Z", freshAfter: "2026-11-25T05:00:00Z" }, now, TZ);
    expect(lines.map((l) => [l.text, l.person, l.closeQuote, l.closedInMeeting, l.closedAtTime, l.fresh])).toEqual([
      ["Tarun confirms timeline", "Tarun", "timeline is fine for Friday", "Standup", "11:00 AM", true],
      ["Send Nitin the banner text", null, "Got the banner text", "Standup", "11:00 AM", true],
    ]);
    expect(closedSince(data, { since: "2026-11-25T07:00:00Z", freshAfter: null }, now, TZ)).toEqual([]);
    expect(closedSince(data, { since: null, freshAfter: null }, now, TZ)).toEqual([]);
    // shown but not highlighted again on a refresh
    expect(closedSince(data, { since: "2026-11-25T05:00:00Z", freshAfter: "2026-11-25T07:00:00Z" }, now, TZ).every((l) => !l.fresh)).toBe(true);
  });
  it("ignores items you marked done yourself, and names the day for an older close", async () => {
    const { s, user, item } = await week();
    await s.setItemStatus(item("Share the deck with Nitin").id, "done", "2026-11-25T08:00:00Z");
    const lines = closedSince(await loadBriefData(s, user.id), { since: "2026-11-01T00:00:00Z", freshAfter: null }, new Date("2026-11-26T12:00:00Z"), TZ);
    expect(lines.map((l) => l.text)).not.toContain("Share the deck with Nitin");
    expect(lines[0].closedAtTime).toBe("25 Nov, 11:00 AM");
  });
});

describe("buildWrap", () => {
  it("counts the day and matches the brief's wrap numbers", async () => {
    const { s, user, item } = await week();
    await s.setItemStatus(item("Share the deck with Nitin").id, "done", "2026-11-25T08:00:00Z");
    const w = buildWrap(await loadBriefData(s, user.id), now, TZ);
    expect(w.counts).toEqual({ meetings: 1, made: 1, kept: 2, late: 1, open: 2 });
    const b = await buildBrief(s, user, now);
    expect(b.wrap).toEqual({ meetings: w.counts.meetings, made: w.counts.made, kept: w.counts.kept, late: w.counts.late });
    expect(b.openPromises).toBe(w.counts.open);
    expect(w.promises).toEqual([expect.objectContaining({ text: "Review the copy", state: "late", label: "2h late", meetingTitle: "Standup", meetingTime: "11:00 AM" })]);
    expect(w.closes.map((c) => [c.text, c.closeQuote, c.closedInMeeting, c.closedAtTime])).toEqual([
      ["Tarun confirms timeline", "timeline is fine for Friday", "Standup", "11:00 AM"],
      ["Send Nitin the banner text", "Got the banner text", "Standup", "11:00 AM"],
      ["Share the deck with Nitin", null, null, "1:30 PM"],
    ]);
    expect(w.empty).toBe(false);
  });
  it("is empty when nothing is owed", async () => {
    const { s, user, meet, add } = await seed();
    const m = await meet("m1", "Standup", "2026-11-25T05:30:00Z");
    await add(m.id, "2026-11-25T06:00:00Z", [{ kind: "decision", text: "Keep Friday" }]);
    const w = buildWrap(await loadBriefData(s, user.id), now, TZ);
    expect(w.empty).toBe(true);
    expect(w.counts).toEqual({ meetings: 1, made: 0, kept: 0, late: 0, open: 0 });
  });
  it("the daily note carries a Wrap section with the same numbers", async () => {
    const { s, user } = await week();
    const md = renderMarkdown(await buildBrief(s, user, now));
    expect(md).toContain("## Wrap\n\n- Meetings: 1\n- Promises made: 1\n- Kept: 1\n- Late: 1\n- Still open: 3\n");
  });
});

describe("weeks", () => {
  it("numbers ISO weeks", () => {
    expect(isoWeek("2026-11-25")).toMatchObject({ year: 2026, week: 48, key: "2026-W48", monday: "2026-11-23", sunday: "2026-11-29" });
    expect(isoWeek("2027-01-01").key).toBe("2026-W53"); // a Friday that belongs to the old year's week
    expect(isoWeek("2026-01-01").key).toBe("2026-W01");
    expect(isoWeek("2024-12-30").key).toBe("2025-W01");
    expect(isoWeek("2026-11-29").monday).toBe("2026-11-23");
  });
  it("Friday is recap day", () => {
    expect(isRecapDay("2026-11-27")).toBe(true);
    expect(isRecapDay("2026-11-25")).toBe(false);
  });
  it("labels the range", () => {
    expect(weekRangeLabel("2026-11-23", "2026-11-29")).toBe("23–29 November");
    expect(weekRangeLabel("2026-11-30", "2026-12-06")).toBe("30 November – 6 December");
  });
});

describe("buildWeek", () => {
  const friday = new Date("2026-11-27T12:30:00Z"); // Fri 6:00 PM IST

  it("sums promises, people, decisions and what's been open over a week", async () => {
    const { s, user } = await week();
    const w = buildWeek(await loadBriefData(s, user.id), friday, TZ);
    expect(w.key).toBe("2026-W48");
    expect(w.label).toBe("Week 48, 23–29 November");
    expect(w.counts).toEqual({ meetings: 2, made: 3, kept: 1, late: 2 }); // banner closed after its due time; copy still open
    expect(w.youOwe).toEqual([
      { person: "Asha", total: 2, open: 2 },
      { person: "Nitin", total: 2, open: 1 },
    ]);
    expect(w.oweYou).toEqual([{ person: "Asha", total: 1, open: 1 }]); // Tarun's is from an older week and closed
    expect(w.decisions.map((d) => [d.text, d.quote, d.meetingTitle, d.day, d.time])).toEqual([
      ["Ship the banner on Friday", "quote for Ship the banner on Friday", "Planning", "Mon 23 Nov", "11:00 AM"],
      ["Move the review to Thursday", "quote for Move the review to Thursday", "Standup", "Wed 25 Nov", "11:00 AM"],
    ]);
    expect(w.stale.map((x) => [x.text, x.ageDays, x.day])).toEqual([["Write the launch FAQ", 15, "12 Nov"]]);

    const md = renderWeekMarkdown(w);
    expect(md).toContain("week: 2026-W48");
    expect(md).toContain("# Week 48, 23–29 November");
    expect(md).toContain("3 promises made, 1 kept, 2 late. From 2 meetings.");
    expect(md).toContain("## People you owe\n\n- Asha: 2 open\n- Nitin: 1 open, 1 closed");
    expect(md).toContain("- Ship the banner on Friday\n  \"quote for Ship the banner on Friday\" · Planning, Mon 23 Nov, 11:00 AM");
    expect(renderWeekMarkdown({ ...w, oweYou: [{ person: "Tarun", total: 1, open: 0 }] })).toContain("- Tarun: 1 closed");
    expect(md).toContain("## Open more than 7 days (1)\n\n- [ ] Write the launch FAQ (15d)");
  });
});
