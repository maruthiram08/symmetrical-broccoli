import { describe, expect, it } from "vitest";
import type { Item, Meeting } from "@/lib/types";
import { renderReviewHtml, reviewFileName } from "./html";
import { buildReview, currentKeys, durationLabel, keptRate, monthPeriod, yearPeriod } from "./review";

const TZ = "Asia/Kolkata";
const NOW = new Date("2026-11-26T06:00:00Z");
const user = { name: "Maruthi", aliases: ["Maru"], timeZone: TZ };

const meeting = (id: string, title: string, startedAt: string): Meeting =>
  ({ id, userId: "u", providerMeetingId: id, title, startedAt, participants: [], processedAt: startedAt });

let n = 0;
function item(p: Partial<Item>): Item {
  return {
    id: `i${++n}`, userId: "u", kind: "owe", text: "A thing", person: null, quote: "a quote", meetingId: "m1",
    dueAt: null, status: "open", closedByMeetingId: null, closeQuote: null, createdAt: "2026-11-01T00:00:00Z", closedAt: null, ...p,
  };
}

const meetings = [
  meeting("m0", "October sync", "2026-10-30T05:00:00Z"),
  meeting("m1", "Launch sync", "2026-11-03T05:00:00Z"),
  meeting("m2", "Standup", "2026-11-17T04:00:00Z"),
  // 1 Dec 00:30 in Kolkata is still 30 Nov in UTC: belongs to December.
  meeting("m3", "Late night", "2026-11-30T19:00:00Z"),
];
const items: Item[] = [
  item({ text: "Send Nitin the deck", person: "Nitin", meetingId: "m1", quote: "I'll send the deck", dueAt: "2026-11-05T12:30:00Z", status: "done", closedAt: "2026-11-04T05:00:00Z", closedByMeetingId: "m2", closeQuote: "got the deck" }),
  item({ text: "Review Nitin K's plan", person: "Nitin K", meetingId: "m1", dueAt: "2026-11-10T12:30:00Z" }), // late, open
  item({ text: "Book the venue", person: "Priya", meetingId: "m2", dueAt: "2026-11-18T12:30:00Z", status: "done", closedAt: "2026-11-20T05:00:00Z" }), // kept late
  item({ text: "Call Maru", person: "Maru", meetingId: "m2" }), // yourself: no person row
  item({ kind: "waiting", text: "Priya to share tokens", person: "Priya", meetingId: "m2", status: "done", closedAt: "2026-11-17T05:00:00Z", closedByMeetingId: "m2" }),
  item({ kind: "decision", text: "Ship Friday", meetingId: "m1" }),
  item({ kind: "decision", text: "Three steps", meetingId: "m2" }),
  item({ kind: "decision", text: "Wrong one", meetingId: "m2", status: "wrong" }),
  item({ kind: "decision", text: "October call", meetingId: "m0" }),
  item({ text: "Kept from October", person: "Leela", meetingId: "m0", status: "done", closedAt: "2026-11-02T05:00:00Z" }),
  item({ text: "December thing", meetingId: "m3" }),
  item({ text: "Manual one", meetingId: "manual", source: "manual", createdAt: "2026-11-25T05:00:00Z" }),
];

describe("periods", () => {
  it("builds local month and year bounds with prev/next", () => {
    const m = monthPeriod("2026-11", TZ)!;
    expect(m).toMatchObject({ kind: "month", label: "November 2026", prev: "2026-10", next: "2026-12" });
    expect(m.startIso).toBe("2026-10-31T18:30:00.000Z");
    expect(m.endIso).toBe("2026-11-30T18:30:00.000Z");
    expect(monthPeriod("2026-01", TZ)!.prev).toBe("2025-12");
    expect(monthPeriod("2026-12", TZ)!.next).toBe("2027-01");
    expect(yearPeriod("2026", TZ)).toMatchObject({ label: "2026", prev: "2025", next: "2027" });
    expect(monthPeriod("2026-13", TZ)).toBeNull();
    expect(monthPeriod("nov", TZ)).toBeNull();
    expect(yearPeriod("26", TZ)).toBeNull();
    expect(currentKeys(new Date("2026-12-31T19:00:00Z"), TZ)).toEqual({ month: "2027-01", year: "2027" });
  });
});

describe("buildReview (month)", () => {
  const r = buildReview({ items, meetings, user, period: monthPeriod("2026-11", TZ)!, now: NOW });

  it("counts made, kept, late and closed by meetings", () => {
    expect(r.counts).toEqual({
      meetings: 2, // m0 is October, m3 is December in Kolkata
      made: 5, // deck, plan, venue, call maru, manual
      kept: 3, // deck, venue, kept-from-October (closed in November)
      late: 2, // plan (open past due), venue (kept after due)
      closed: 4, // + the waiting item
      closedByMeetings: 2,
      waiting: 1,
      decisions: 2, // the wrong one never counts
    });
    expect(keptRate(r.counts)).toBe(60);
  });

  it("lists people you promised most, grouping spellings and leaving yourself out", () => {
    expect(r.people).toEqual([
      { name: "Nitin K", slug: "nitin-k", made: 2, kept: 1, open: 1 },
      { name: "Priya", slug: "priya", made: 1, kept: 1, open: 0 },
    ]);
  });

  it("buckets decisions by week of the month", () => {
    expect(r.decisionsBy.map((d) => d.label)).toEqual(["1–7 Nov", "8–14 Nov", "15–21 Nov", "22–28 Nov", "29–30 Nov"]);
    expect(r.decisionsBy.map((d) => d.count)).toEqual([1, 0, 1, 0, 0]);
  });

  it("finds the longest open and the fastest closed", () => {
    expect(r.longestOpen[0]).toMatchObject({ text: "Review Nitin K's plan", stillOpen: true });
    expect(r.longestOpen.map((i) => i.text)).not.toContain("Ship Friday");
    expect(r.fastestClosed.map((i) => i.text)).toEqual(["Priya to share tokens", "Send Nitin the deck", "Book the venue"]);
    expect(r.fastestClosed[0].openMinutes).toBe(60);
    expect(r.longestOpen.find((i) => i.text === "Manual one")?.meetingTitle).toBe("Added by you");
  });
});

describe("buildReview (year)", () => {
  it("buckets decisions by month", () => {
    const r = buildReview({ items, meetings, user, period: yearPeriod("2026", TZ)!, now: NOW });
    expect(r.decisionsBy).toHaveLength(12);
    expect(r.decisionsBy[9]).toMatchObject({ key: "2026-10", label: "Oct", count: 1 });
    expect(r.decisionsBy[10].count).toBe(2);
    expect(r.counts.made).toBe(7);
  });
});

describe("renderReviewHtml", () => {
  const r = buildReview({ items, meetings, user, period: monthPeriod("2026-11", TZ)!, now: NOW });

  it("is a standalone page with no scripts and no quotes by default", () => {
    const html = renderReviewHtml(r, { quotes: false, timeZone: TZ, now: NOW });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>November 2026 review</title>");
    expect(html).toContain("60% kept");
    expect(html).toContain("Nitin K");
    expect(html).not.toMatch(/<script|<link|src=|href=/i);
    expect(html).not.toContain("I&#39;ll send the deck");
    expect(html).toContain("quotes left out");
  });

  it("includes quotes when asked, escaped", () => {
    const evil = [...items, item({ text: "<b>x</b>", quote: `"<img>"`, meetingId: "m2" })];
    const r2 = buildReview({ items: evil, meetings, user, period: monthPeriod("2026-11", TZ)!, now: NOW, listSize: 20 });
    const html = renderReviewHtml(r2, { quotes: true, timeZone: TZ, now: NOW });
    expect(html).toContain("&ldquo;I&#39;ll send the deck&rdquo;");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<img>");
    expect(html).not.toContain("quotes left out");
  });

  it("names the download after the period", () => {
    expect(reviewFileName(r)).toBe("daily-brief-review-2026-11.html");
    expect(renderReviewHtml(buildReview({ items, meetings, user, period: yearPeriod("2026", TZ)!, now: NOW }), { quotes: false, timeZone: TZ, now: NOW }))
      .toContain("<title>2026 in review</title>");
  });
});

describe("durationLabel", () => {
  it("reads as minutes, hours or days", () => {
    expect(durationLabel(0)).toBe("1 min");
    expect(durationLabel(59)).toBe("59 min");
    expect(durationLabel(90)).toBe("2 h");
    expect(durationLabel(47 * 60)).toBe("47 h");
    expect(durationLabel(5 * 1440)).toBe("5 d");
  });
});
