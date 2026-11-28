import { describe, expect, it } from "vitest";
import { switchOn } from "./switch";

describe("integration enable switch", () => {
  it("is off with no saved token, even if a stale config says enabled", () => {
    expect(switchOn(false, null)).toBe(false);
    expect(switchOn(true, null)).toBe(false);
  });
  it("is off with a saved token that hasn't passed its test, on once it has", () => {
    expect(switchOn(false, "…abcd")).toBe(false);
    expect(switchOn(true, "…abcd")).toBe(true);
  });
});
