import { describe, expect, it } from "vitest";
import { parseMode, themeAttr } from "./mode";

describe("appearance mode", () => {
  it("reads only light and dark, anything else follows the system", () => {
    expect(parseMode("light")).toBe("light");
    expect(parseMode("dark")).toBe("dark");
    expect(parseMode("blue")).toBe("system");
    expect(parseMode(undefined)).toBe("system");
  });
  it("sets data-theme only when overriding the system", () => {
    expect(themeAttr("system")).toBeUndefined();
    expect(themeAttr("light")).toBe("light");
    expect(themeAttr("dark")).toBe("dark");
  });
});
