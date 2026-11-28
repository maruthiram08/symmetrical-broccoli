import { describe, expect, it } from "vitest";
import { dropEmptyFrontMatter, joinFrontMatter, parseScalar, readEntries, readProperties, setProperties, splitFrontMatter, yamlString } from "./frontmatter";

const FIXTURES: Record<string, string> = {
  simple: "---\ntype: Project\nstatus: active\n---\n# Launch\n\nBody\n",
  crlf: "---\r\ntitle: x\r\ntags: [a, b]\r\n---\r\n\r\n# Body\r\n",
  bom: "﻿---\nkey: 1\n---\nbody",
  comments: "---\n# a comment\nowner: \"[[person:Nitin K]]\"   # who\n\nempty:\n---\n",
  blockList: "---\nattendees:\n  - Nitin\n  - 'Priya S'\n- loose\n---\ntext\n",
  nested: "---\nmeta:\n  a: 1\n  b: [x]\ntext: |\n  multi\n  line\n---\n",
  noClose: "---\nnot: front matter\n\njust a divider at the top\n",
  dividerOnly: "---\n\ntext\n",
  emptyFm: "---\n---\nbody\n",
  eofFence: "---\na: b\n---",
  dotsFence: "---\na: b\n...\nbody\n",
  mixedEndings: "---\na: 1\r\nb: 2\n---\r\nbody\n",
  trailingSpaces: "---   \nkey:   value   \n---  \nbody",
  none: "# Just a note\n",
  empty: "",
};

describe("front matter round trip", () => {
  for (const [name, md] of Object.entries(FIXTURES)) {
    it(`keeps "${name}" byte for byte when untouched`, () => {
      const fm = splitFrontMatter(md);
      expect(joinFrontMatter(fm)).toBe(md);
      // Reading never changes anything, and setting the same values is a no-op.
      const props = readProperties(md);
      const same: Record<string, unknown> = {};
      for (const e of readEntries(fm.raw)) if (e.kind !== "raw") same[e.key] = e.value;
      expect(setProperties(md, same as never)).toBe(md);
      expect(props).toBeTypeOf("object");
    });
  }

  it("splits at the closing fence", () => {
    expect(splitFrontMatter(FIXTURES.simple)).toEqual({ raw: "---\ntype: Project\nstatus: active\n---\n", body: "# Launch\n\nBody\n" });
    expect(splitFrontMatter(FIXTURES.noClose).raw).toBe("");
    expect(splitFrontMatter(FIXTURES.eofFence)).toEqual({ raw: "---\na: b\n---", body: "" });
  });
});

describe("reading properties", () => {
  it("reads scalars, lists, links and comments", () => {
    expect(readProperties(FIXTURES.comments)).toEqual({ owner: "[[person:Nitin K]]", empty: null });
    expect(readProperties(FIXTURES.blockList)).toEqual({ attendees: ["Nitin", "Priya S", "loose"] });
    expect(readProperties(FIXTURES.crlf)).toEqual({ title: "x", tags: ["a", "b"] });
    expect(readProperties("---\nn: 3.5\nz: 007\nok: true\nno: False\nd: 2026-11-26\nq: 'it''s'\ne: \"a\\\"b\"\n---\n")).toEqual({ n: 3.5, z: "007", ok: true, no: false, d: "2026-11-26", q: "it's", e: 'a"b' });
  });

  it("keeps what it can't read as raw", () => {
    const e = readEntries(splitFrontMatter(FIXTURES.nested).raw);
    expect(e.map((x) => [x.key, x.kind])).toEqual([["meta", "raw"], ["text", "raw"]]);
  });

  it("parses scalars like YAML", () => {
    expect(parseScalar("  # only a comment")).toBeNull();
    expect(parseScalar("hello # there")).toBe("hello");
    expect(parseScalar("a#b")).toBe("a#b");
    expect(parseScalar("~")).toBeNull();
  });
});

describe("changing properties", () => {
  it("rewrites only the changed key", () => {
    const md = "---\n# keep me\ntype: Project\nstatus:   active   # inline\nowner: \"[[person:Nitin]]\"\n---\nbody\n";
    expect(setProperties(md, { status: "done" })).toBe("---\n# keep me\ntype: Project\nstatus: done\nowner: \"[[person:Nitin]]\"\n---\nbody\n");
  });

  it("adds new keys at the end and keeps CRLF", () => {
    expect(setProperties(FIXTURES.crlf, { due: "2026-12-01", done: false })).toBe("---\r\ntitle: x\r\ntags: [a, b]\r\ndue: 2026-12-01\r\ndone: false\r\n---\r\n\r\n# Body\r\n");
  });

  it("keeps a block list as a block list", () => {
    expect(setProperties(FIXTURES.blockList, { attendees: ["Nitin", "Ravi"] })).toBe("---\nattendees:\n  - Nitin\n  - Ravi\n---\ntext\n");
  });

  it("removes keys, and the front matter when nothing is left", () => {
    const out = setProperties(FIXTURES.simple, { type: undefined, status: undefined });
    expect(out).toBe("---\n---\n# Launch\n\nBody\n");
    expect(dropEmptyFrontMatter(out)).toBe("# Launch\n\nBody\n");
  });

  it("adds front matter to a note without one", () => {
    expect(setProperties("# Hi\r\nthere\r\n", { type: "Project" })).toBe("---\r\ntype: Project\r\n---\r\n# Hi\r\nthere\r\n");
    expect(setProperties("﻿# Hi\n", { n: 2 })).toBe("﻿---\nn: 2\n---\n# Hi\n");
  });

  it("quotes only when it must, and reads back what it wrote", () => {
    for (const v of ["plain", "true", "12", "a: b", "#tag", "[[note:x|X]]", " pad", "it's", 'say "hi"', "", "- dash", "back\\slash"]) {
      const md = setProperties("", { k: v });
      expect(readProperties(md).k).toBe(v);
    }
    expect(yamlString("plain words")).toBe("plain words");
    expect(yamlString("[[person:Nitin]]")).toBe('"[[person:Nitin]]"');
    const list = setProperties("", { tags: ["a/b", "c d", "x, y"] });
    expect(readProperties(list).tags).toEqual(["a/b", "c d", "x, y"]);
  });
});
