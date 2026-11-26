import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { afterEach, describe, expect, it } from "vitest";
import { splitNotes, withNotes } from "@/lib/capture/notes";
import { createPage, readPage, savePage } from "@/server/local/pages";
import { lineSeparatorOf, notesParser } from "./markdown";
import { baseExtensions, docText } from "./setup";
import { TABLE_TEMPLATE, insertFor } from "./slash";

const FIXTURES: Record<string, string> = {
  plain: "# Q4 plan\n\nSome text with **bold**, *em*, ~~gone~~ and `code`.\n",
  noTrailingNewline: "# Title\n\nlast line without newline",
  crlf: "# Windows\r\n\r\n- one\r\n- two\r\n",
  mixedMostlyCrlf: "a\r\nb\r\nc\nd\r\n",
  mixedMostlyLf: "a\nb\nc\r\nd\n",
  loneCr: "old mac\rline\n",
  trailingSpaces: "line with two spaces  \nnext line\t\n\n\n\nafter four newlines\n",
  frontMatter: "---\ntitle: x\ntags: [a, b]\n---\n\n# Body\n",
  html: "<details><summary>More</summary>\n\nHidden *stuff*\n\n</details>\n\n<!-- a comment -->\n",
  callout: "> [!note] Heads up\n> second line\n>\n> after a blank quote line\n",
  decision: "> [!decision] We ship on Monday\n",
  table: "| a | b |\n|:--|--:|\n| 1 | 2 \\| 3 |\n",
  tasks: "- [ ] open\n- [x] done\n  - [X] nested capital X\n* [ ] star bullet\n1. [ ] numbered\n",
  links: "See [[person:Nitin K]], [[note:q4-plan|Q4 plan]], [[Untyped]], [[item:abc123|Send the deck]] and [web](https://example.com).\n",
  code: "```ts\nconst a = [[not a link]];\n```\n\n    indented code\n",
  unicode: "﻿नमस्ते — kal tak bhej dunga 🙏\n nbsp line\n",
  setext: "Title\n=====\n\nSub\n---\n",
  emptyLines: "\n\n\n",
  empty: "",
  escapes: "\\*not em\\* and \\[[not link]] &amp; &copy;\n",
  hardBreaks: "line one\\\nline two\n",
  lazyQuote: "> quote\nlazy continuation\n",
};

describe("markdown round trip", () => {
  for (const [name, md] of Object.entries(FIXTURES)) {
    it(`keeps "${name}" byte for byte through the editor`, () => {
      const state = EditorState.create({ doc: md, extensions: baseExtensions(md) });
      ensureSyntaxTree(state, state.doc.length, 5000);
      expect(docText(state)).toBe(md);
      // An edit and its undo-equivalent keep the rest of the file as it was.
      const edited = state.update({ changes: { from: 0, insert: "x" } }).state;
      const back = edited.update({ changes: { from: 0, to: 1 } }).state;
      expect(docText(back)).toBe(md);
    });
  }

  it("keeps CRLF on new lines typed into a CRLF file", () => {
    const md = FIXTURES.crlf;
    const state = EditorState.create({ doc: md, extensions: baseExtensions(md) });
    const next = state.update({ changes: { from: state.doc.length, insert: state.lineBreak + "- three" } }).state;
    expect(docText(next)).toBe("# Windows\r\n\r\n- one\r\n- two\r\n\r\n- three");
  });

  it("detects the line separator", () => {
    expect(lineSeparatorOf("a\nb")).toBe("\n");
    expect(lineSeparatorOf("a\r\nb\r\n")).toBe("\r\n");
    expect(lineSeparatorOf("")).toBe("\n");
  });

  it("parses every fixture without losing a character in the tree", () => {
    for (const md of Object.values(FIXTURES)) expect(notesParser.parse(md).length).toBe(md.length);
  });
});

describe("pages on disk", () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("saves and reads a page exactly, for every fixture", () => {
    dir = mkdtempSync(join(tmpdir(), "db-pages-"));
    const { slug } = createPage("Round trip", dir);
    let base = readPage(slug, dir)!.hash;
    for (const md of Object.values(FIXTURES)) {
      const r = savePage(slug, md, base, dir);
      expect(r.ok).toBe(true);
      if (r.ok) { expect(r.conflict).toBeUndefined(); base = r.hash; }
      expect(readFileSync(join(dir, "notes", `${slug}.md`), "utf8")).toBe(md);
      expect(readPage(slug, dir)!.markdown).toBe(md);
    }
  });

  it("keeps a copy when the file changed in another app since it was opened", () => {
    dir = mkdtempSync(join(tmpdir(), "db-pages-"));
    const { slug } = createPage("Clash", dir);
    const opened = readPage(slug, dir)!.hash;
    savePage(slug, "# Clash\n\nedited elsewhere\n", null, dir);
    const r = savePage(slug, "# Clash\n\nmine\n", opened, dir, new Date("2026-11-26T10:00:00Z"));
    expect(r.ok && r.conflict).toBe("clash.conflict-2026-11-26T10-00-00-000Z.md");
    expect(readFileSync(join(dir, "notes", r.ok ? r.conflict! : ""), "utf8")).toBe("# Clash\n\nedited elsewhere\n");
    expect(readPage(slug, dir)!.markdown).toBe("# Clash\n\nmine\n");
  });

  it("gives clashing titles their own slug", () => {
    dir = mkdtempSync(join(tmpdir(), "db-pages-"));
    expect(createPage("Q4 plan", dir).slug).toBe("q4-plan");
    expect(createPage("Q4 plan!", dir).slug).toBe("q4-plan-2");
    expect(readPage("q4-plan", dir)!.title).toBe("Q4 plan");
    expect(readPage("../etc", dir)).toBeNull();
  });
});

describe("day notes keep editor Markdown", () => {
  it("round-trips rich blocks through the your-notes block", () => {
    const notes = [FIXTURES.callout, FIXTURES.table, FIXTURES.tasks, FIXTURES.links, FIXTURES.html].join("\n").trimEnd();
    const md = withNotes("# 2026-11-26\n\n## You owe\n\n- a thing\n", notes);
    expect(splitNotes(md).notes).toBe(notes);
    expect(splitNotes(withNotes(md, splitNotes(md).notes)).notes).toBe(notes);
  });
});

describe("rich blocks are plain Markdown", () => {
  const nodes = (md: string) => {
    const names = new Set<string>();
    notesParser.parse(md).iterate({ enter: (n) => { names.add(n.name); } });
    return names;
  };
  it("table, checklist, callout and toggle parse as standard Markdown", () => {
    expect(nodes(TABLE_TEMPLATE).has("Table")).toBe(true);
    expect(nodes(insertFor("checklist", { today: "" }).text + "x").has("Task")).toBe(true);
    expect(nodes(insertFor("callout", { today: "" }).text).has("Blockquote")).toBe(true);
    expect(nodes(insertFor("divider", { today: "" }).text).has("HorizontalRule")).toBe(true);
    const toggle = nodes(insertFor("toggle", { today: "", lineRest: "More" }).text);
    expect(toggle.has("HTMLBlock")).toBe(true);
  });
});
