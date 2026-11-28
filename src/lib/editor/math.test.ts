import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { notesParser } from "./markdown";
import { mathEnabled, mathSource } from "./math-tex";
import { previewSpecs, type Spec } from "./preview-specs";
import { baseExtensions } from "./setup";
import { parseBlocks } from "@/lib/export/doc";
import { blocksHtml } from "@/lib/export/html";

const maths = (md: string) => {
  const out: Array<{ name: string; text: string }> = [];
  notesParser.parse(md).iterate({ enter: (n) => { if (n.name === "InlineMath" || n.name === "BlockMath") out.push({ name: n.name, text: md.slice(n.from, n.to) }); } });
  return out;
};

const specs = (doc: string, cursor: number | null) => {
  let state = EditorState.create({ doc, extensions: baseExtensions(doc), selection: EditorSelection.cursor(cursor ?? 0) });
  ensureSyntaxTree(state, state.doc.length, 5000);
  state = state.update({}).state;
  return previewSpecs(state, { focused: cursor !== null });
};
const mathSpecs = (xs: Spec[]) => xs.filter((s): s is Extract<Spec, { t: "math" }> => s.t === "math");

describe("LaTeX syntax", () => {
  it("reads inline and block math", () => {
    expect(maths("Euler: $e^{i\\pi}+1=0$.")).toEqual([{ name: "InlineMath", text: "$e^{i\\pi}+1=0$" }]);
    expect(maths("mid $$x^2$$ line")).toEqual([{ name: "InlineMath", text: "$$x^2$$" }]);
    expect(maths("$$\n\\int_0^1 x\\,dx\n$$\nafter")).toEqual([{ name: "BlockMath", text: "$$\n\\int_0^1 x\\,dx\n$$" }]);
    expect(maths("$$ a+b $$")).toEqual([{ name: "BlockMath", text: "$$ a+b $$" }]);
  });

  it("leaves money alone", () => {
    for (const s of ["Price $50 and $60 today", "costs $5, or $10.", "US$5 and AU$7", "a \\$5 and \\$6", "$ 5 $", "between $20-$30 a seat", "₹3.5 a meeting"]) expect(maths(s)).toEqual([]);
  });

  it("keeps _ inside math out of emphasis", () => {
    const names: string[] = [];
    notesParser.parse("$a_1$ and $b_1$").iterate({ enter: (n) => { names.push(n.name); } });
    expect(names).not.toContain("Emphasis");
  });

  it("never runs past a line, and a lone $$ stays text", () => {
    expect(maths("$a\nb$")).toEqual([]);
    expect(maths("$$\nnot closed\n\nnext paragraph $$")).toEqual([]);
  });

  it("reads math inside a quote", () => {
    const m = maths("> $$\n> x^2\n> $$");
    expect(m[0]?.name).toBe("BlockMath");
    expect(mathSource(m[0].text, true)).toBe("x^2");
  });

  it("can be turned off per note", () => {
    expect(mathEnabled("---\nmath: false\n---\n$x$")).toBe(false);
    expect(mathEnabled("---\ntitle: a\n---\n$x$")).toBe(true);
    expect(mathEnabled("$x$")).toBe(true);
    expect(mathSpecs(specs("---\nmath: false\n---\n$x$", null))).toEqual([]);
  });
});

describe("LaTeX in the live preview", () => {
  it("draws a formula, and shows its source while the cursor is in it", () => {
    const doc = "Area $\\pi r^2$ here";
    expect(mathSpecs(specs(doc, null))).toEqual([{ t: "math", from: 5, to: 14, tex: "\\pi r^2", display: false }]);
    expect(mathSpecs(specs(doc, 8))).toEqual([]);
    expect(mathSpecs(specs(doc, 17))).toHaveLength(1);
  });

  it("draws a block over its whole lines", () => {
    const doc = "a\n\n$$\nx^2\n$$\n\nb";
    const s = mathSpecs(specs(doc, 0));
    expect(s).toEqual([{ t: "math", from: 3, to: 12, tex: "x^2", display: true }]);
    expect(mathSpecs(specs(doc, 6))).toEqual([]);
  });

  it("shows an escaped dollar as a dollar", () => {
    const hides = specs("costs \\$5", null).filter((s) => s.t === "hide");
    expect(hides).toContainEqual({ t: "hide", from: 6, to: 7 });
  });
});

describe("LaTeX in exports", () => {
  it("turns math into MathML, and bad TeX into code", () => {
    const html = blocksHtml(parseBlocks("Inline $x^2$.\n\n$$\n\\frac{a}{b}\n$$\n\nBad $\\frac{a$ here, and $50 and $60."));
    expect(html).toContain("<math");
    expect(html).toContain("<mfrac>");
    expect(html).toContain('class="math-error"');
    expect(html).toContain("$50 and $60");
  });
});
