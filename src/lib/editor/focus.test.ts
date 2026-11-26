import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { focusDecorations, paragraphRange, parseFocusConf, readFocusConf, sentenceRange } from "./focus";

const doc = Text.of(["# Title", "", "First sentence here. Second one! Third?", "still the same paragraph.", "", "Next paragraph."]);
const at = (s: string, k = 0) => doc.toString().indexOf(s) + k;
const slice = (r: { from: number; to: number }) => doc.sliceString(r.from, r.to);

describe("focus mode", () => {
  it("keeps the paragraph around the cursor", () => {
    expect(slice(paragraphRange(doc, at("Second")))).toBe("First sentence here. Second one! Third?\nstill the same paragraph.");
    expect(slice(paragraphRange(doc, at("Next")))).toBe("Next paragraph.");
    expect(slice(paragraphRange(doc, at("# Title")))).toBe("# Title");
    expect(slice(paragraphRange(doc, doc.line(2).from))).toBe("");
  });

  it("or just the sentence", () => {
    expect(slice(sentenceRange(doc, at("Second", 3)))).toBe("Second one!");
    expect(slice(sentenceRange(doc, at("First", 2)))).toBe("First sentence here.");
    expect(slice(sentenceRange(doc, at("Third", 2)))).toBe("Third?");
    // Right after the full stop you are still in that sentence.
    expect(slice(sentenceRange(doc, at("here.", 5)))).toBe("First sentence here.");
    expect(slice(sentenceRange(doc, at("still", 3)))).toBe("still the same paragraph.");
  });

  it("dims every other line, and the rest of the line in sentence mode", () => {
    const keep = sentenceRange(doc, at("Second", 1));
    const set = focusDecorations(doc, keep, [{ from: 0, to: doc.length }]);
    const lines: number[] = [];
    const marks: string[] = [];
    set.between(0, doc.length, (from, to, d) => {
      if (from === to) lines.push(doc.lineAt(from).number);
      else marks.push(`${doc.sliceString(from, to)}|${(d.spec as { class: string }).class}`);
    });
    expect(lines).toEqual([1, 2, 4, 5, 6]);
    expect(marks).toEqual(["First sentence here. |cm-focus-dimtext", " Third?|cm-focus-dimtext"]);
  });

  it("reads its setting safely", () => {
    expect(parseFocusConf(null)).toEqual({ on: false, unit: "paragraph", typewriter: true });
    expect(parseFocusConf('{"on":true,"unit":"sentence","typewriter":false}')).toEqual({ on: true, unit: "sentence", typewriter: false });
    expect(parseFocusConf("{broken")).toMatchObject({ on: false });
    // No localStorage here (as with storage blocked): off, no throw.
    expect(readFocusConf().on).toBe(false);
  });
});
