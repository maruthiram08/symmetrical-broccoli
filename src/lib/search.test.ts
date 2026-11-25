import { describe, expect, it } from "vitest";
import type { Item, Meeting } from "@/lib/types";
import { buildIndex, highlight, search, terms } from "./search";

let n = 0;
const meeting = (over: Partial<Meeting> = {}): Meeting => ({
  id: `m${++n}`, userId: "u", providerMeetingId: `p${n}`, title: "Standup", startedAt: "2026-11-20T05:00:00Z", participants: [], processedAt: "x", ...over,
});
const item = (over: Partial<Item> = {}): Item => ({
  id: `i${++n}`, userId: "u", kind: "owe", text: "Do a thing", person: null, quote: "q", meetingId: "", dueAt: null,
  status: "open", closedByMeetingId: null, closeQuote: null, createdAt: "2026-11-20T06:00:00Z", closedAt: null, ...over,
});

describe("terms", () => {
  it("lowercases, strips punctuation and dedupes", () => {
    expect(terms("  Banner, banner TEXT! ")).toEqual(["banner", "text"]);
    expect(terms("  ")).toEqual([]);
  });
});

describe("search", () => {
  const old = meeting({ title: "Banner review", startedAt: "2026-11-10T05:00:00Z" });
  const recent = meeting({ title: "Launch sync", startedAt: "2026-11-24T05:00:00Z", participants: ["Priya Shah"] });
  const items = [
    item({ id: "phrase", meetingId: old.id, text: "Send Nitin the final banner text" }),
    item({ id: "all", meetingId: recent.id, text: "Text the banner to legal" }),
    item({ id: "some", meetingId: recent.id, text: "Pick a banner colour" }),
    item({ id: "quote", meetingId: old.id, text: "Book a room", quote: "I'll grab the big one", status: "done", closeQuote: "booked it" }),
    item({ id: "person", meetingId: old.id, text: "Review copy", person: "Nitin K" }),
    item({ id: "gone", meetingId: recent.id, text: "banner text wrong", status: "wrong" }),
  ];
  const ix = buildIndex(items, [old, recent]);
  const ids = (q: string) => search(ix, q).map((h) => h.id);

  it("ranks exact phrase, then all words, then some words", () => {
    expect(ids("banner text").slice(0, 3)).toEqual(["phrase", "all", "some"]);
  });

  it("puts recent first on ties", () => {
    // own matches first, then items found only through their meeting's title
    expect(ids("banner")).toEqual(["all", "some", "phrase", old.id, "quote", "person"]);
  });

  it("searches quotes, closing quotes, people and meeting titles, open and closed", () => {
    expect(ids("grab")).toEqual(["quote"]);
    expect(ids("booked")).toEqual(["quote"]);
    expect(ids("nitin").sort()).toEqual(["person", "phrase"]);
    expect(ids("priya")).toEqual([recent.id]);
    expect(ids("launch")[0]).toBe(recent.id);
  });

  it("matches word starts only and skips items marked wrong", () => {
    expect(ids("ann")).toEqual([]);
    expect(ids("bann")).not.toContain("gone");
  });

  it("returns nothing for an empty query", () => {
    expect(search(ix, "   ")).toEqual([]);
  });

  it("stays under 50 ms for a few thousand items", () => {
    const ms = Array.from({ length: 400 }, (_, k) => meeting({ title: `Weekly sync ${k}`, startedAt: new Date(Date.UTC(2026, 0, 1) + k * 3600e3).toISOString(), participants: ["Nitin", "Priya"] }));
    const words = "send banner deck review legal copy launch budget hire invoice roadmap".split(" ");
    const many = Array.from({ length: 5000 }, (_, k) => item({
      meetingId: ms[k % ms.length].id,
      text: `${words[k % 11]} the ${words[(k * 7) % 11]} for ${words[(k * 3) % 11]} ${k}`,
      quote: `we said ${words[(k * 5) % 11]} by friday`, person: k % 3 ? "Nitin" : "Priya",
    }));
    const t0 = performance.now();
    const big = buildIndex(many, ms);
    for (const q of ["banner deck", "nitin", "roadmap budget friday", "weekly sync 12", "zzz"]) search(big, q);
    const each = (performance.now() - t0) / 5;
    expect(each).toBeLessThan(50);
  });
});

describe("highlight", () => {
  const hits = (text: string, q: string) => highlight(text, q).filter((s) => s.hit).map((s) => s.text);
  it("marks every matched word start, case-insensitively", () => {
    expect(hits("Send Nitin the banner text", "banner NITIN")).toEqual(["Nitin", "banner"]);
    expect(hits("Banners and bans", "ban")).toEqual(["Ban", "ban"]);
  });
  it("does not mark inside words", () => {
    expect(hits("Cabbage", "bag")).toEqual([]);
  });
  it("keeps the whole text", () => {
    expect(highlight("Send the banner", "banner").map((s) => s.text).join("")).toBe("Send the banner");
    expect(highlight("x", "")).toEqual([{ text: "x", hit: false }]);
    expect(highlight("", "a")).toEqual([]);
  });
});
