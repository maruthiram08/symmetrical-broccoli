import { describe, expect, it } from "vitest";
import {
  itemMatches,
  keyNoun,
  passes,
  personMatches,
  scoreMeeting,
  tokenOverlap,
  totals,
  type Expected,
} from "./score";
import type { ExtractionResult } from "../src/lib/types";

const item = (
  kind: "owe" | "waiting" | "decision",
  text: string,
  person: string | null,
): ExtractionResult["newItems"][number] => ({ kind, text, person, quote: "q", dueAt: null });

describe("matchers", () => {
  it("token overlap ignores stopwords and plurals", () => {
    expect(tokenOverlap("Send the banners to Nitin", "send banner Nitin")).toBe(1);
    expect(tokenOverlap("Fix login bug", "Write release notes")).toBe(0);
  });

  it("key noun skips verbs and the person's name", () => {
    expect(keyNoun("Send Nitin the final banner text", "Nitin")).toBe("banner");
    expect(keyNoun("Send it", null)).toBeNull();
  });

  it("person matches fuzzily", () => {
    expect(personMatches("Nitin", "nitin")).toBe(true);
    expect(personMatches("Nitin", "Nitin Kumar")).toBe(true);
    expect(personMatches("Nitin", "Nithin")).toBe(true);
    expect(personMatches("Nitin", "Priya")).toBe(false);
    expect(personMatches(null, null)).toBe(true);
    expect(personMatches("Nitin", null)).toBe(false);
  });

  it("items match on kind + person + (overlap or key noun)", () => {
    const e = { kind: "owe" as const, text: "Send Nitin the final banner text", person: "Nitin" };
    expect(itemMatches(e, item("owe", "Share banner copy", "Nitin"))).toBe(true); // key noun
    expect(itemMatches(e, item("owe", "Send final banner text to Nitin", "Nitin"))).toBe(true); // overlap
    expect(itemMatches(e, item("waiting", "Send Nitin the final banner text", "Nitin"))).toBe(false); // kind
    expect(itemMatches(e, item("owe", "Send Nitin the final banner text", "Priya"))).toBe(false); // person
    expect(itemMatches(e, item("owe", "Review the PR", "Nitin"))).toBe(false); // text
  });

  it("decisions ignore person", () => {
    expect(
      itemMatches({ kind: "decision", text: "Use the blue banner", person: null }, item("decision", "Go with blue banner", "Nitin")),
    ).toBe(true);
  });
});

describe("scoreMeeting / totals", () => {
  const expected: Expected = {
    newItems: [
      { kind: "owe", text: "Send Nitin the final banner text", person: "Nitin" },
      { kind: "waiting", text: "Push build to staging", person: "Nitin" },
      { kind: "decision", text: "Go with the blue banner", person: null },
    ],
    closes: ["a", "b"],
  };

  it("counts correct, missed, wrong and closes; matches one-to-one", () => {
    const s = scoreMeeting(expected, {
      newItems: [
        item("owe", "Send final banner text", "Nitin"),
        item("owe", "Send banner text again", "Nitin"), // would match the same expected item: counted wrong
        item("decision", "Ship blue banner", null),
      ],
      closes: [
        { itemId: "a", quote: "q" },
        { itemId: "c", quote: "q" },
      ],
    });
    expect(s.correct).toHaveLength(2);
    expect(s.missed.map((m) => m.text)).toEqual(["Push build to staging"]);
    expect(s.wrong.map((w) => w.text)).toEqual(["Send banner text again"]);
    expect(s.correctCloses).toEqual(["a"]);
    expect(s.wrongCloses).toEqual(["c"]);
    expect(s.missedCloses).toEqual(["b"]);

    const t = totals([s]);
    // hits = 2 items + 1 close = 3; predicted = 3 + 1 wrong + 1 wrong close = 5; expected = 3 + 1 + 1 = 5
    expect(t.precision).toBeCloseTo(3 / 5);
    expect(t.recall).toBeCloseTo(3 / 5);
    expect(passes(t)).toBe(false);
  });

  it("perfect run passes; empty run counts as perfect", () => {
    const s = scoreMeeting(expected, {
      newItems: [
        item("owe", "Send Nitin the final banner text", "Nitin"),
        item("waiting", "Push build to staging", "Nitin"),
        item("decision", "Go with the blue banner", null),
      ],
      closes: [
        { itemId: "a", quote: "q" },
        { itemId: "b", quote: "q" },
      ],
    });
    expect(passes(totals([s]))).toBe(true);
    expect(totals([scoreMeeting({ newItems: [], closes: [] }, { newItems: [], closes: [] })])).toMatchObject({
      precision: 1,
      recall: 1,
    });
  });
});
