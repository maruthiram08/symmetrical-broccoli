import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { matchTargets, linkText, type LinkTarget } from "./commands";
import { backlinks, findWikiLinks, formatWikiLink, linkHref, linksToNote, linksToPerson, noteSlug, parseWikiLink } from "./links";
import { previewSpecs, tableCells, type Spec } from "./preview-specs";
import { baseExtensions } from "./setup";
import { dateFor, filterCommands, insertFor, itemLine, localLine, parseItemCommand, parseLineCommand, slashQueryAt } from "./slash";

// Thursday 26 Nov 2026, 10:00 in Kolkata.
const NOW = new Date("2026-11-26T04:30:00Z");
const TZ = "Asia/Kolkata";
const CTX = { people: ["Nitin K", "Tarun"], self: ["Maruthi"], now: NOW, timeZone: TZ };

describe("slash commands", () => {
  it("finds the /query being typed at a line start or after a space", () => {
    expect(slashQueryAt("/")).toEqual({ from: 0, query: "" });
    expect(slashQueryAt("/tod")).toEqual({ from: 0, query: "tod" });
    expect(slashQueryAt("- [ ] /ow")).toEqual({ from: 6, query: "ow" });
    expect(slashQueryAt("some text /ta")).toEqual({ from: 10, query: "ta" });
    expect(slashQueryAt("https://x.com/a")).toBeNull();
    expect(slashQueryAt("and/or")).toBeNull();
    expect(slashQueryAt("/todo send")).toBeNull();
  });

  it("ranks commands by id, then aliases", () => {
    expect(filterCommands("")).toHaveLength(15);
    expect(filterCommands("t")[0].id).toBe("todo");
    expect(filterCommands("ta")[0].id).toBe("table");
    expect(filterCommands("h2")[0].id).toBe("heading");
    expect(filterCommands("hr")[0].id).toBe("divider");
    expect(filterCommands("wait")[0].id).toBe("waiting");
    expect(filterCommands("details")[0].id).toBe("toggle");
    expect(filterCommands("zzz")).toEqual([]);
  });

  it("covers every command the roadmap asks for", () => {
    const ids = filterCommands("").map((c) => c.id);
    for (const id of ["todo", "owe", "waiting", "decision", "date", "person", "link", "heading", "quote", "callout", "divider", "table"]) expect(ids).toContain(id);
  });

  it("inserts Markdown for block commands", () => {
    expect(insertFor("heading", { today: "", lineRest: "Plan" })).toEqual({ text: "## Plan", wholeLine: true });
    expect(insertFor("quote", { today: "" }).text).toBe("> ");
    expect(insertFor("callout", { today: "" })).toMatchObject({ text: "> [!note] Note", cursor: 10, selectTo: 14 });
    expect(insertFor("divider", { today: "" }).text).toBe("---\n");
    expect(insertFor("table", { today: "" }).text.split("\n")).toHaveLength(4);
    expect(insertFor("checklist", { today: "", lineRest: "buy milk" }).text).toBe("- [ ] buy milk");
    expect(insertFor("toggle", { today: "", lineRest: "More" }).text).toBe("<details><summary>More</summary>\n\n\n\n</details>");
    expect(insertFor("person", { today: "" })).toEqual({ text: "[[person:", complete: true });
    expect(insertFor("link", { today: "" })).toEqual({ text: "[[", complete: true });
    expect(insertFor("date", { today: "2026-11-26" }).text).toBe("[[day:2026-11-26]]");
    expect(insertFor("todo", { today: "" }).text).toBe("/todo ");
  });

  it("parses a typed line command, after any list marker", () => {
    expect(parseLineCommand("/todo send Nitin the deck by Fri")).toEqual({ id: "todo", arg: "send Nitin the deck by Fri", indent: "" });
    expect(parseLineCommand("- [ ] /owe Tarun the budget")).toEqual({ id: "owe", arg: "Tarun the budget", indent: "- [ ] " });
    expect(parseLineCommand("  - /waiting Tarun API spec")).toMatchObject({ id: "waiting", indent: "  - " });
    expect(parseLineCommand("/date")).toEqual({ id: "date", arg: "", indent: "" });
    expect(parseLineCommand("/todos")).toBeNull();
    expect(parseLineCommand("text /todo x")).toBeNull();
  });

  it("/todo uses the capture parser: kind, person and due date", () => {
    expect(parseItemCommand("todo", "send Nitin the deck by Fri", CTX)).toMatchObject({ kind: "owe", person: "Nitin K", dueDate: "2026-11-27", text: "Send Nitin the deck" });
    expect(parseItemCommand("todo", "Tarun owes me API spec tomorrow", CTX)).toMatchObject({ kind: "waiting", person: "Tarun", dueDate: "2026-11-27" });
    expect(parseItemCommand("waiting", "Tarun API spec", CTX)).toMatchObject({ kind: "waiting", person: "Tarun" });
    expect(parseItemCommand("owe", "Tarun will get the budget", CTX)).toMatchObject({ kind: "owe" });
    expect(parseItemCommand("todo", "   ", CTX)).toBeNull();
  });

  it("writes the item back into the note as a linked checkbox", () => {
    const p = parseItemCommand("todo", "send Nitin the deck by Fri", CTX)!;
    expect(itemLine(p, "it_1")).toBe("- [ ] [[item:it_1|Send Nitin the deck]] · for [[person:Nitin K]] · due Fri 27 Nov");
    const w = parseItemCommand("waiting", "Tarun API spec", CTX)!;
    expect(itemLine(w, "it_2", "  - ")).toBe("  - [ ] [[item:it_2|Tarun API spec]] · waiting on [[person:Tarun]]");
    expect(itemLine({ kind: "owe", text: "x", person: null, dueDate: null }, "i", "- [ ] ")).toBe("- [ ] [[item:i|x]]");
  });

  it("/decision and /date finish locally", () => {
    expect(localLine({ id: "decision", arg: "Ship v2 Monday", indent: "" }, NOW, TZ)).toBe("> [!decision] Ship v2 Monday");
    expect(localLine({ id: "decision", arg: "", indent: "" }, NOW, TZ)).toBeNull();
    expect(localLine({ id: "date", arg: "", indent: "" }, NOW, TZ)).toBe("[[day:2026-11-26]]");
    expect(localLine({ id: "date", arg: "fri", indent: "- " }, NOW, TZ)).toBe("- [[day:2026-11-27]]");
    expect(dateFor("yesterday", NOW, TZ)).toBe("2026-11-25");
    expect(dateFor("next week", NOW, TZ)).toBe("2026-11-30");
    expect(dateFor("banana", NOW, TZ)).toBeNull();
  });
});

describe("links", () => {
  it("parses typed and untyped links", () => {
    expect(parseWikiLink("[[person:Nitin K]]")).toMatchObject({ kind: "person", target: "Nitin K", label: "Nitin K" });
    expect(parseWikiLink("[[note:q4-plan|Q4 plan]]")).toMatchObject({ kind: "note", target: "q4-plan", label: "Q4 plan" });
    expect(parseWikiLink("[[Something]]")).toMatchObject({ kind: null, target: "Something" });
    expect(parseWikiLink("[[http://x]]")).toMatchObject({ kind: null, target: "http://x" });
    expect(parseWikiLink("[[]]")).toBeNull();
    expect(parseWikiLink("[[person:]]")).toBeNull();
  });

  it("formats links that parse back to themselves", () => {
    expect(formatWikiLink("person", "Nitin K")).toBe("[[person:Nitin K]]");
    expect(formatWikiLink("item", "a1", "Send [the] deck | now")).toBe("[[item:a1|Send the deck now]]");
    expect(formatWikiLink("note", "q4", "q4")).toBe("[[note:q4]]");
    const l = parseWikiLink(formatWikiLink("meeting", "m_1", "Standup · 25 Nov"))!;
    expect(l).toMatchObject({ kind: "meeting", target: "m_1", label: "Standup · 25 Nov" });
  });

  it("finds links outside code only", () => {
    const md = "a [[person:Tarun]] b `[[no]]`\n\n```\n[[no]]\n```\n\n- [ ] [[item:x|Do it]]\n";
    expect(findWikiLinks(md).map((l) => l.target)).toEqual(["Tarun", "x"]);
    expect(findWikiLinks(md)[0]).toMatchObject({ from: 2, to: 18 });
  });

  it("resolves hrefs", () => {
    expect(linkHref({ kind: "person", target: "Nitin K", label: "" })).toBe("/people/nitin-k");
    expect(linkHref({ kind: "note", target: "q4-plan", label: "" })).toBe("/notes/q4-plan");
    expect(linkHref({ kind: "item", target: "a b", label: "" })).toBe("/item/a%20b");
    expect(linkHref({ kind: "day", target: "2026-11-26", label: "" })).toBe("/day/2026-11-26");
    expect(linkHref({ kind: null, target: "Q4 plan", label: "" }, { notes: [{ slug: "q4-plan", title: "Q4 plan" }] })).toBe("/notes/q4-plan");
    expect(linkHref({ kind: null, target: "Tarun", label: "" })).toBe("/people/tarun");
    expect(noteSlug("Café — Q4 plan!")).toBe("cafe-q4-plan");
  });

  it("builds backlinks for a person and a note", () => {
    const sources = [
      { type: "note" as const, id: "q4-plan", title: "Q4 plan", markdown: "# Q4 plan\n\n- [ ] Ask [[person:Nitin K]] for **numbers**\n" },
      { type: "day" as const, id: "2026-11-25", title: "2026-11-25", markdown: "Met [[Nitin]] about [[note:q4-plan|the plan]]\n" },
      { type: "day" as const, id: "2026-11-26", title: "2026-11-26", markdown: "> [!note] [[Nitin K]] is out Friday\n" },
      { type: "note" as const, id: "other", title: "Other", markdown: "Nothing here, `[[person:Nitin K]]`\n" },
    ];
    const keys = ["Nitin K", "nitin", "Nitin"];
    const forNitin = backlinks(sources, (l) => linksToPerson(l, keys));
    expect(forNitin.map((b) => b.id)).toEqual(["2026-11-26", "2026-11-25", "q4-plan"]);
    expect(forNitin[0].snippets).toEqual(["Nitin K is out Friday"]);
    expect(forNitin[2]).toMatchObject({ href: "/notes/q4-plan", snippets: ["Ask Nitin K for numbers"] });
    const forPlan = backlinks(sources, (l) => linksToNote(l, { slug: "q4-plan", title: "Q4 plan" }), { type: "note", id: "q4-plan" });
    expect(forPlan.map((b) => b.href)).toEqual(["/day/2026-11-25"]);
    // An untyped link that names a note is the note's, not a person's.
    expect(linksToPerson(parseWikiLink("[[Q4 plan]]")!, ["Q4 plan"], { notes: [{ slug: "q4-plan", title: "Q4 plan" }] })).toBe(false);
  });

  it("matches autocomplete targets, narrowed by kind", () => {
    const targets: LinkTarget[] = [
      { kind: "item", target: "i1", label: "Send Nitin the deck" },
      { kind: "person", target: "Nitin K", label: "Nitin K" },
      { kind: "note", target: "q4-plan", label: "Q4 plan" },
      { kind: "meeting", target: "m1", label: "Nitin sync" },
    ];
    expect(matchTargets("nit", targets).map((t) => t.kind)).toEqual(["person", "meeting", "item"]);
    expect(matchTargets("person:", targets).map((t) => t.target)).toEqual(["Nitin K"]);
    expect(matchTargets("deck", targets).map((t) => t.target)).toEqual(["i1"]);
    expect(linkText(targets[1])).toBe("[[person:Nitin K]]");
    expect(linkText(targets[2])).toBe("[[note:q4-plan|Q4 plan]]");
  });
});

describe("live preview", () => {
  const specs = (doc: string, cursor: number | null) => {
    let state = EditorState.create({ doc, extensions: baseExtensions(doc), selection: EditorSelection.cursor(cursor ?? 0) });
    ensureSyntaxTree(state, state.doc.length, 5000);
    state = state.update({}).state;
    return previewSpecs(state, { focused: cursor !== null });
  };
  const of = <T extends Spec["t"]>(xs: Spec[], t: T) => xs.filter((s): s is Extract<Spec, { t: T }> => s.t === t);

  it("hides heading marks except on the line being edited", () => {
    const doc = "# Title\n\ntext\n";
    expect(of(specs(doc, 9), "hide")).toEqual([{ t: "hide", from: 0, to: 2 }]);
    expect(of(specs(doc, 3), "hide")).toEqual([]);
    expect(of(specs(doc, null), "hide")).toHaveLength(1);
    expect(of(specs(doc, 3), "line")[0]).toMatchObject({ cls: "cm-md-h cm-md-h1" });
  });

  it("draws checkboxes, and shows the raw marker when the cursor is on it", () => {
    const doc = "- [ ] open\n- [x] done\n";
    const away = specs(doc, null);
    expect(of(away, "check")).toEqual([{ t: "check", from: 2, to: 5, checked: false }, { t: "check", from: 13, to: 16, checked: true }]);
    expect(of(away, "line").some((l) => l.cls === "cm-md-task-done" && l.at === 11)).toBe(true);
    expect(of(specs(doc, 3), "check")).toHaveLength(1);
  });

  it("turns [[links]] into chips, raw while the cursor is inside", () => {
    const doc = "see [[person:Tarun]] now";
    expect(of(specs(doc, null), "link")).toEqual([{ t: "link", from: 4, to: 20, label: "Tarun", href: "/people/tarun", kind: "person" }]);
    expect(of(specs(doc, 10), "link")).toEqual([]);
    expect(of(specs(doc, 10), "mark")[0]).toMatchObject({ cls: "cm-md-wikiraw" });
  });

  it("renders callouts, tables, dividers and toggles", () => {
    const doc = "> [!warning] Careful\n> body\n\n| a | b |\n| --- | :-: |\n| 1 | 2 |\n\n---\n\n<details><summary>More</summary>\n\ninside\n\n</details>\n";
    const s = specs(doc, null);
    expect(of(s, "callout")).toEqual([{ t: "callout", from: 2, to: 13, kind: "warning" }]);
    expect(of(s, "line").filter((l) => l.cls.includes("cm-md-callout--warning"))).toHaveLength(2);
    expect(of(s, "table")[0]).toMatchObject({ rows: [["a", "b"], ["1", "2"]], align: [null, "center"] });
    expect(of(s, "hr")).toHaveLength(1);
    const toggle = of(s, "toggle")[0];
    expect(toggle).toMatchObject({ title: "More", folded: false });
    expect(doc.slice(toggle.foldTo - "</details>".length, toggle.foldTo)).toBe("</details>");
    // With the cursor in the table, its source shows.
    expect(of(specs(doc, doc.indexOf("| 1")), "table")).toEqual([]);
  });

  it("hides emphasis marks around text not being edited", () => {
    const doc = "a **b** c";
    expect(of(specs(doc, null), "hide")).toEqual([{ t: "hide", from: 2, to: 4 }, { t: "hide", from: 5, to: 7 }]);
    expect(of(specs(doc, 3), "hide")).toEqual([]);
  });

  it("hints Enter on a typed line command", () => {
    const doc = "/todo send Nitin the deck";
    expect(of(specs(doc, doc.length), "hint")).toEqual([{ t: "hint", at: doc.length, text: "Enter to add to You owe" }]);
  });

  it("splits table cells, keeping escaped pipes", () => {
    expect(tableCells("| a | b \\| c |")).toEqual(["a", "b | c"]);
    expect(tableCells("a|b")).toEqual(["a", "b"]);
  });
});
