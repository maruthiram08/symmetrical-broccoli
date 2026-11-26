import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { docBlocks, fileBase, parseBlocks, plain, type Inline } from "./doc";
import { renderExportHtml } from "./html";
import { renderDocx } from "./docx";

const NOTE = `---
tags: plan
---
# Q4 plan

Ask [[person:Nitin K|Nitin]] about **the *deck*** and \`api\`, ~~old~~ [site](https://example.com) [bad](javascript:alert(1)).
Second line <script>alert(1)</script>

- [ ] Send the deck
- [x] Book venue
  - nested point

3. third
4. fourth

> [!decision] Ship Friday
> Everyone agreed

> plain quote

| Who | What |
| --- | --- |
| Nitin | **deck** |

\`\`\`
code <b>here</b>
\`\`\`

<details><summary>More</summary>

Hidden text

</details>

---
<!-- daily-brief:your-notes -->
![img](https://example.com/x.png)
`;

describe("Markdown to blocks", () => {
  const b = parseBlocks(NOTE);
  it("reads headings, lists, tasks, quotes, callouts, tables and code", () => {
    expect(b.map((x) => x.t)).toEqual(["h", "p", "list", "list", "callout", "quote", "table", "code", "p", "p", "hr", "p"]);
    const tasks = b[2];
    expect(tasks.t === "list" && tasks.items.map((i) => i.checked)).toEqual([false, true]);
    expect(tasks.t === "list" && tasks.items[1].blocks[1].t).toBe("list");
    const ol = b[3];
    expect(ol.t === "list" && ol.ordered && ol.start).toBe(3);
    const callout = b[4];
    expect(callout.t === "callout" && [callout.kind, plain(callout.title), plain((callout.blocks[0] as unknown as { c: Inline[] }).c)]).toEqual(["decision", "Ship Friday", "Everyone agreed"]);
    const table = b[6];
    expect(table.t === "table" && [table.head.map(plain), table.rows.map((r) => r.map(plain))]).toEqual([["Who", "What"], [["Nitin", "deck"]]]);
  });
  it("shows [[links]] as their label and keeps only web links", () => {
    const p = b[1];
    expect(p.t).toBe("p");
    if (p.t !== "p") return;
    expect(p.c).toContainEqual({ t: "wiki", label: "Nitin" });
    expect(p.c).toContainEqual({ t: "link", href: "https://example.com", c: [{ t: "text", v: "site" }] });
    expect(JSON.stringify(p.c)).not.toContain("javascript:");
    expect(plain(p.c)).toContain("Second line");
  });
  it("drops front matter, markers, and a first heading that repeats the title", () => {
    expect(JSON.stringify(b)).not.toContain("tags: plan");
    expect(JSON.stringify(b)).not.toContain("daily-brief:");
    expect(docBlocks({ title: "Q4 plan", markdown: NOTE })[0].t).toBe("p");
  });
  it("makes safe file names", () => {
    expect(fileBase("Q4 plan: ünïcode / stuff!")).toBe("q4-plan-unicode-stuff");
    expect(fileBase("///")).toBe("export");
  });
});

describe("HTML export", () => {
  const html = renderExportHtml({ title: "Q4 plan", subtitle: "Note", markdown: NOTE }, { now: new Date("2026-11-26T00:00:00Z") });
  it("is one self-contained, escaped document with print styles", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>Q4 plan</title>");
    expect(html).toContain("@media print");
    expect(html).toContain("@page");
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/<img\b/i);
    expect(html).not.toMatch(/src=/i);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("code &lt;b&gt;here&lt;/b&gt;");
    expect(html).not.toContain("localhost");
    expect(html).toContain('<span class="wl">Nitin</span>');
    expect(html).toContain('<a href="https://example.com"');
    expect(html).toContain('<ol start="3">');
    expect(html).toContain("Exported from Daily brief, 26 Nov 2026.");
  });
});

/** The text of word/document.xml inside a .docx (a zip), without a zip library. */
function documentXml(buf: Buffer): string {
  for (let i = 0; i < buf.length - 30; i++) {
    if (buf.readUInt32LE(i) !== 0x04034b50) continue;
    const method = buf.readUInt16LE(i + 8), size = buf.readUInt32LE(i + 18), nameLen = buf.readUInt16LE(i + 26), extra = buf.readUInt16LE(i + 28);
    const name = buf.toString("utf8", i + 30, i + 30 + nameLen);
    if (name !== "word/document.xml") continue;
    const data = buf.subarray(i + 30 + nameLen + extra, i + 30 + nameLen + extra + size);
    return method === 8 ? inflateRawSync(data).toString("utf8") : data.toString("utf8");
  }
  throw new Error("no document.xml");
}

describe("Word export", () => {
  it("writes a .docx with the title, text, tasks and table", async () => {
    const buf = await renderDocx({ title: "Q4 plan", subtitle: "Note", markdown: NOTE }, new Date("2026-11-26T00:00:00Z"));
    expect(buf.subarray(0, 2).toString()).toBe("PK");
    const xml = documentXml(buf);
    for (const s of ["Q4 plan", "Send the deck", "Book venue", "Ship Friday", "Everyone agreed", "Nitin", "deck", "code &lt;b&gt;here&lt;/b&gt;", "☐", "☑", "Exported from Daily brief"]) expect(xml).toContain(s);
    expect(xml).toContain("<w:tbl>");
    expect(xml).not.toContain("javascript:");
  });
});
