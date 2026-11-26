import { describe, expect, it } from "vitest";
import { parseDayQuery, validDay } from "./natural";

// Thursday 26 November 2026.
const TODAY = "2026-11-26";

describe("natural-language days for ⌘K", () => {
  it("understands the phrases people type", () => {
    expect(parseDayQuery("yesterday", TODAY)).toBe("2026-11-25");
    expect(parseDayQuery("today", TODAY)).toBe("2026-11-26");
    expect(parseDayQuery("tomorrow", TODAY)).toBe("2026-11-27");
    expect(parseDayQuery("last tuesday", TODAY)).toBe("2026-11-24");
    expect(parseDayQuery("3 days ago", TODAY)).toBe("2026-11-23");
    expect(parseDayQuery("next fri", TODAY)).toBe("2026-12-04");
    expect(parseDayQuery("25 nov", TODAY)).toBe("2026-11-25");
    expect(parseDayQuery("nov 25", TODAY)).toBe("2026-11-25");
    expect(parseDayQuery("1 dec", TODAY)).toBe("2026-12-01");
    expect(parseDayQuery("Last Tuesday.", TODAY)).toBe("2026-11-24");
    expect(parseDayQuery("go to yesterday", TODAY)).toBe("2026-11-25");
    expect(parseDayQuery("2026-02-03", TODAY)).toBe("2026-02-03");
  });

  it("works across month and year ends", () => {
    expect(parseDayQuery("yesterday", "2027-01-01")).toBe("2026-12-31");
    expect(parseDayQuery("3 days ago", "2026-03-02")).toBe("2026-02-27");
  });

  it("leaves searches alone", () => {
    expect(parseDayQuery("send the deck friday", TODAY)).toBeNull();
    expect(parseDayQuery("pricing", TODAY)).toBeNull();
    expect(parseDayQuery("5pm", TODAY)).toBeNull();
    expect(parseDayQuery("", TODAY)).toBeNull();
    expect(parseDayQuery("2026-02-30", TODAY)).toBeNull();
  });

  it("checks real dates", () => {
    expect(validDay("2028-02-29")).toBe(true);
    expect(validDay("2026-02-29")).toBe(false);
    expect(validDay("26-11-2026")).toBe(false);
  });
});
