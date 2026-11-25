import { describe, expect, it } from "vitest";
import { startOfDayIso, todayIn } from "./time";

describe("startOfDayIso", () => {
  it("is local midnight in the zone", () => {
    expect(startOfDayIso("2026-11-01", "Asia/Kolkata")).toBe("2026-10-31T18:30:00.000Z");
    expect(startOfDayIso("2026-11-01", "UTC")).toBe("2026-11-01T00:00:00.000Z");
    expect(startOfDayIso("2026-07-01", "America/New_York")).toBe("2026-07-01T04:00:00.000Z");
    expect(startOfDayIso("2026-12-01", "America/New_York")).toBe("2026-12-01T05:00:00.000Z");
  });
  it("rejects bad dates", () => {
    expect(startOfDayIso("2026-02-30", "UTC")).toBeNull();
    expect(startOfDayIso("yesterday", "UTC")).toBeNull();
  });
});

describe("todayIn", () => {
  it("uses the zone's calendar day", () => {
    expect(todayIn("Asia/Kolkata", new Date("2026-11-25T19:00:00Z"))).toBe("2026-11-26");
    expect(todayIn("UTC", new Date("2026-11-25T19:00:00Z"))).toBe("2026-11-25");
  });
});
