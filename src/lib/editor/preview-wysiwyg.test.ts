import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { findWikiLinks } from "./links";
import { notesParser } from "./markdown";
import { defaultAsset, embedLines } from "./preview";
import { previewSpecs, type Spec } from "./preview-specs";
import { baseExtensions } from "./setup";

const specs = (doc: string, cursor: number | null) => {
  let state = EditorState.create({ doc, extensions: baseExtensions(doc), selection: EditorSelection.cursor(cursor ?? 0) });
  ensureSyntaxTree(state, state.doc.length, 5000);
  state = state.update({}).state;
  return previewSpecs(state, { focused: cursor !== null });
};
const of = <T extends Spec["t"]>(xs: Spec[], t: T) => xs.filter((s): s is Extract<Spec, { t: T }> => s.t === t);
const nodes = (md: string) => { const n: string[] = []; notesParser.parse(md).iterate({ enter: (x) => { n.push(x.name); } }); return n; };

describe("syntax beyond GFM", () => {
  it("parses ==highlights==, ![[embeds]] and [^footnotes]", () => {
    expect(nodes("a ==b== c")).toContain("Highlight");
    expect(nodes("![[Other note]]")).toEqual(expect.arrayContaining(["Embed", "WikiLink"]));
    expect(nodes("text[^1]")).toContain("FootnoteRef");
    expect(nodes("a == b")).not.toContain("Highlight");
    expect(nodes("`==no==`")).not.toContain("Highlight");
    expect(nodes("![alt](pic.png)")).toContain("Image");
  });

  it("counts an embed as a link, for backlinks", () => {
    expect(findWikiLinks("see ![[Alpha]] and [[Beta]]").map((l) => l.target)).toEqual(["Alpha", "Beta"]);
  });
});

describe("live preview, closer to WYSIWYG", () => {
  it("hides markup everywhere but the cursor line", () => {
    const doc = "a **b** c\nd *e* f";
    // Cursor on line 2, away from the emphasis there: line 2's markup shows, line 1's is hidden.
    expect(of(specs(doc, doc.length), "hide")).toEqual([{ t: "hide", from: 2, to: 4 }, { t: "hide", from: 5, to: 7 }]);
    expect(of(specs(doc, 0), "hide")).toEqual([{ t: "hide", from: 12, to: 13 }, { t: "hide", from: 14, to: 15 }]);
  });

  it("draws highlights and inline code without their marks", () => {
    const doc = "x ==hot== and `code`\n";
    const s = specs(doc, null);
    expect(of(s, "mark").map((m) => m.cls)).toEqual(expect.arrayContaining(["cm-md-highlight", "cm-md-code"]));
    expect(of(s, "hide").map((h) => doc.slice(h.from, h.to))).toEqual(["==", "==", "`", "`"]);
  });

  it("shows images in place, raw on the cursor line", () => {
    const doc = "![A chart](img/chart.png)\n\n![[Pasted image.png]]\n";
    const s = specs(doc, null);
    expect(of(s, "image")).toEqual([
      { t: "image", from: 0, to: 25, src: "img/chart.png", alt: "A chart", wiki: false },
      { t: "image", from: 27, to: 48, src: "Pasted image.png", alt: "", wiki: true },
    ]);
    expect(of(specs(doc, 3), "image")).toHaveLength(1);
  });

  it("embeds notes", () => {
    const doc = "Before\n![[Q4 plan|the plan]]\n";
    expect(of(specs(doc, 0), "embed")).toEqual([{ t: "embed", from: 7, to: 28, target: "Q4 plan", label: "the plan" }]);
    expect(of(specs(doc, 10), "embed")).toEqual([]);
    expect(of(specs(doc, 0), "link")).toEqual([]);
  });

  it("turns footnotes into numbers, with the note as a tooltip", () => {
    const doc = "Claim[^1] here.\n\n[^1]: The source.\n";
    const s = specs(doc, null);
    expect(of(s, "footref")).toEqual([{ t: "footref", from: 5, to: 9, label: "1", text: "The source." }]);
    expect(of(s, "footdef")).toEqual([{ t: "footdef", from: 17, to: 23, label: "1" }]);
    expect(of(s, "line").some((l) => l.cls === "cm-md-footdef")).toBe(true);
    expect(of(specs(doc, 2), "footref")).toEqual([]);
  });

  it("draws mermaid blocks as diagrams, and shows the source while editing them", () => {
    const doc = "Intro\n\n```mermaid\ngraph TD\n  A-->B\n```\n\nAfter\n";
    const away = specs(doc, 0);
    expect(of(away, "mermaid")).toEqual([{ t: "mermaid", from: 7, to: 38, code: "graph TD\n  A-->B" }]);
    expect(of(away, "line").filter((l) => l.cls.includes("codeblock"))).toEqual([]);
    const inside = specs(doc, doc.indexOf("A-->"));
    expect(of(inside, "mermaid")).toEqual([]);
    expect(of(inside, "line").filter((l) => l.cls.includes("codeblock"))).toHaveLength(4);
  });

  it("hides code fences when the cursor isn't in the block", () => {
    const doc = "```ts\nconst a = 1;\n```\n\nx";
    const hidden = of(specs(doc, doc.length), "hide").map((h) => doc.slice(h.from, h.to));
    expect(hidden).toEqual(["```", "```"]);
    expect(of(specs(doc, 8), "hide")).toEqual([]);
  });
});

describe("embeds and images", () => {
  it("draws an embedded note's lines simply", () => {
    expect(embedLines("---\ntags: x\n---\n# Plan\n\n- [ ] ship **it**\n- [x] done\n* point [[person:Nitin K]]\n\n> quote\ntext")).toEqual([
      { cls: "h1", text: "Plan" },
      { cls: "gap", text: "" },
      { cls: "task", text: "☐ ship it" },
      { cls: "task done", text: "☑ done" },
      { cls: "li", text: "• point Nitin K" },
      { cls: "gap", text: "" },
      { cls: "quote", text: "quote" },
      { cls: "p", text: "text" },
    ]);
    expect(embedLines("a\nb\nc", 2)).toEqual([{ cls: "p", text: "a" }, { cls: "p", text: "b" }, { cls: "more", text: "…" }]);
  });

  it("points images at the notes folder, relative to the note", () => {
    expect(defaultAsset("https://x.com/a.png", false)).toBe("https://x.com/a.png");
    expect(defaultAsset("pic.png", false, "Projects")).toBe("/api/vault/file?path=Projects%2Fpic.png");
    expect(defaultAsset("../img/a%20b.png", false, "Projects/Q4")).toBe("/api/vault/file?path=Projects%2Fimg%2Fa%20b.png");
    expect(defaultAsset("/attachments/a.png", false, "Projects")).toBe("/api/vault/file?path=attachments%2Fa.png");
    expect(defaultAsset("Pasted image.png", true, "Projects")).toBe("/api/vault/file?name=Pasted%20image.png&from=Projects");
    expect(defaultAsset("javascript:alert(1)", false)).toBeNull();
    expect(defaultAsset("file:///etc/passwd", false)).toBeNull();
  });
});

describe("backlink snippets", () => {
  it("show an embed by its name, without the !", async () => {
    const { backlinks, linksToNote } = await import("./links");
    const b = backlinks([{ type: "note", id: "a", title: "A", markdown: "See ![[Pricing]] here\n" }], (l) => linksToNote(l, { slug: "pricing", title: "Pricing" }));
    expect(b[0].snippets).toEqual(["See Pricing here"]);
  });
});
