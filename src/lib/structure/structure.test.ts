import { describe, expect, it } from "vitest";
import { readProperties } from "./frontmatter";
import { DEFAULT_TYPES, coerce, newNoteText, parseTypes, propTypeFor, typeOf } from "./note-types";
import { captureTokens, findTagRanges, findTags, findTagsLite, flatTags, hasTag, normalizeTag, parseTagList, propertyTags, tagTree } from "./tags";
import { applyView, canDragOn, cleanView, defaultColumns, matchesFilter, sortRows, type ItemRow, type NoteRow } from "./views";
import { matchTypes, parseNewLine } from "./editor";
import { paletteRows } from "./palette";
import { parsePropsText } from "@/components/structure/NoteTypesEditor";

describe("tags", () => {
  it("finds #tags and #nested/tags, not headings, code, links or numbers", () => {
    const md = "# Heading\n\nShip #launch and #Launch/Web, (#ops) #2026 #a1\n`#code` [x](http://a.b/#frag) [[note:x#y]]\n```\n#fenced\n```\nend #q4/plan/ \n";
    expect(findTags(md)).toEqual(["launch", "launch/web", "ops", "a1", "q4/plan"]);
    const r = findTagRanges("a #b c");
    expect(r).toEqual([{ from: 2, to: 4, tag: "b" }]);
    expect(findTags("mail@host#x and url.com#y")).toEqual([]);
    expect(findTagsLite(md)).toEqual(findTags(md));
  });

  it("normalizes and nests", () => {
    expect(normalizeTag("#Q4/Launch/")).toBe("q4/launch");
    expect(normalizeTag("#123")).toBeNull();
    expect(normalizeTag("a b")).toBeNull();
    expect(hasTag(["launch/web"], "launch")).toBe(true);
    expect(hasTag(["launcher"], "launch")).toBe(false);
    expect(propertyTags(["a", "#B", "bad tag"])).toEqual(["a", "b"]);
    expect(propertyTags("a, b c")).toEqual(["a", "b", "c"]);
    expect(parseTagList("#a, b/c  #a")).toEqual(["a", "b/c"]);
  });

  it("builds a tree with counts that include nested tags", () => {
    const tree = tagTree({ notes: [["launch/web"], ["launch"], ["ops"]], items: [["launch/web", "launch"], []] });
    expect(tree.map((n) => [n.tag, n.notes, n.items])).toEqual([["launch", 2, 1], ["ops", 1, 0]]);
    expect(tree[0].children.map((n) => [n.tag, n.name, n.notes, n.items])).toEqual([["launch/web", "web", 1, 1]]);
    expect(flatTags(tree)[0]).toEqual({ tag: "launch", count: 3 });
  });

  it("takes #tags and +project out of a quick capture line", () => {
    expect(captureTokens("send Nitin the deck #launch +q4-plan by Fri #Ops")).toEqual({ rest: "send Nitin the deck by Fri", tags: ["launch", "ops"], project: "q4-plan" });
    expect(captureTokens("call Ravi +1 tomorrow")).toEqual({ rest: "call Ravi +1 tomorrow", tags: [], project: null });
    expect(captureTokens("price is #1 ok")).toEqual({ rest: "price is #1 ok", tags: [], project: null });
  });
});

describe("note types", () => {
  it("makes a new note with front matter, defaults and the template", () => {
    const project = DEFAULT_TYPES.find((t) => t.id === "project")!;
    const md = newNoteText(project, "Q4 launch", "2026-11-26");
    expect(md.startsWith("---\ntype: Project\nstatus: active\nowner:\ndue:\n---\n# Q4 launch\n\n## Goal")).toBe(true);
    const meeting = newNoteText(DEFAULT_TYPES[0], "Standup", "2026-11-26");
    expect(readProperties(meeting)).toMatchObject({ type: "Meeting note", date: "2026-11-26", attendees: [] });
  });

  it("reads a types file, dropping bad entries", () => {
    const types = parseTypes({ version: 1, types: [
      { name: "Recipe", properties: [{ key: "serves", type: "number", default: "4" }, { key: "type", type: "text" }, { key: "x", type: "weird" }], template: "## Steps\n" },
      { name: "" }, { id: "recipe", name: "Dupe" },
    ] });
    expect(types).toEqual([{ id: "recipe", name: "Recipe", properties: [{ key: "serves", type: "number", default: 4 }, { key: "x", type: "text" }], template: "## Steps\n" }]);
    expect(parseTypes(null)).toBe(DEFAULT_TYPES);
  });

  it("knows a note's type and how to edit each property", () => {
    const project = DEFAULT_TYPES.find((t) => t.id === "project")!;
    expect(typeOf({ type: "project" }, DEFAULT_TYPES)).toBe(project);
    expect(typeOf({ type: "Recipe" }, DEFAULT_TYPES)).toBeNull();
    expect(propTypeFor("due", null, project)).toBe("date");
    expect(propTypeFor("x", "2026-01-02", null)).toBe("date");
    expect(propTypeFor("x", "[[person:Nitin]]", null)).toBe("link");
    expect(propTypeFor("x", ["a"], null)).toBe("list");
    expect(coerce("link", "Nitin")).toBe("[[Nitin]]");
    expect(coerce("number", "3.5")).toBe(3.5);
    expect(coerce("list", "a, b,")).toEqual(["a", "b"]);
    expect(coerce("text", "  ")).toBeNull();
  });

  it("reads property lines in the types editor", () => {
    expect(parsePropsText("status: text = active\nattendees: list = A, B\ndone: checkbox = true\nn: number = 2\nplain\n")).toEqual({
      props: [{ key: "status", type: "text", default: "active" }, { key: "attendees", type: "list", default: ["A", "B"] }, { key: "done", type: "checkbox", default: true }, { key: "n", type: "number", default: 2 }, { key: "plain", type: "text" }],
      bad: [],
    });
    expect(parsePropsText("x: colour").bad).toEqual(["x: colour"]);
  });
});

const item = (o: Partial<ItemRow>): ItemRow => ({ id: "i", text: "x", kind: "owe", status: "open", person: null, project: null, tags: [], dueAt: null, createdAt: "2026-11-01T00:00:00Z", manual: false, ...o });
const note = (o: Partial<NoteRow>): NoteRow => ({ slug: "n", title: "N", updatedAt: "2026-11-01T00:00:00Z", type: null, typeName: null, tags: [], props: {}, ...o });

describe("views", () => {
  const items = [
    item({ id: "a", text: "Send deck", person: "Nitin", project: "q4", tags: ["launch/web"], dueAt: "2026-11-28T12:30:00Z" }),
    item({ id: "b", text: "API spec", kind: "waiting", person: "Tarun", project: "q4", dueAt: "2026-11-27T12:30:00Z" }),
    item({ id: "c", text: "Old thing", status: "done" }),
    item({ id: "d", text: "Book venue", tags: ["ops"] }),
  ];

  it("filters by status, kind, person, project and tag", () => {
    expect(items.filter((r) => matchesFilter(r, { field: "status", op: "is", value: "open" })).map((r) => r.id)).toEqual(["a", "b", "d"]);
    expect(items.filter((r) => matchesFilter(r, { field: "tag", op: "has", value: "#launch" })).map((r) => r.id)).toEqual(["a"]);
    expect(items.filter((r) => matchesFilter(r, { field: "person", op: "is", value: "nitin" })).map((r) => r.id)).toEqual(["a"]);
    expect(items.filter((r) => matchesFilter(r, { field: "project", op: "empty" })).map((r) => r.id)).toEqual(["c", "d"]);
    expect(items.filter((r) => matchesFilter(r, { field: "due", op: "before", value: "2026-11-28" })).map((r) => r.id)).toEqual(["b"]);
    expect(items.filter((r) => matchesFilter(r, { field: "text", op: "contains", value: "SPEC" })).map((r) => r.id)).toEqual(["b"]);
  });

  it("sorts with empty values last, both ways", () => {
    expect(sortRows(items, { field: "due", dir: "asc" }).map((r) => r.id)).toEqual(["b", "a", "c", "d"]);
    expect(sortRows(items, { field: "due", dir: "desc" }).map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("groups, with fixed columns for status and project titles", () => {
    const g = applyView({ source: "items", filters: [], sort: null, group: "status" }, items);
    expect(g.map((x) => [x.key, x.rows.length])).toEqual([["open", 3], ["done", 1], ["wrong", 0]]);
    const p = applyView({ source: "items", filters: [], sort: null, group: "project" }, items, (_f, k) => (k === "q4" ? "Q4 launch" : k));
    expect(p.map((x) => [x.key, x.label])).toEqual([["q4", "Q4 launch"], ["", "No project"]]);
  });

  it("works over notes by type and properties", () => {
    const notes = [note({ slug: "q4", title: "Q4", type: "project", typeName: "Project", props: { type: "Project", status: "active", owner: "[[person:Nitin]]" } }), note({ slug: "m", title: "Standup", typeName: "Meeting note", props: { status: "done" } })];
    expect(applyView({ source: "notes", filters: [{ field: "type", op: "is", value: "project" }], sort: null, group: null }, notes)[0].rows.map((r) => r.slug)).toEqual(["q4"]);
    expect(notes.filter((r) => matchesFilter(r, { field: "prop:owner", op: "is", value: "Nitin" })).map((r) => r.slug)).toEqual(["q4"]);
    expect(applyView({ source: "notes", filters: [], sort: null, group: "prop:status" }, notes).map((g) => g.key)).toEqual(["active", "done"]);
    expect(defaultColumns("notes", notes)).toEqual(["title", "type", "prop:status", "prop:owner", "tag", "updated"]);
  });

  it("knows which Kanban fields can be dropped on", () => {
    expect(canDragOn("items", "status")).toBe(true);
    expect(canDragOn("items", "tag")).toBe(false);
    expect(canDragOn("notes", "prop:status")).toBe(true);
    expect(canDragOn("notes", "tag")).toBe(false);
  });

  it("cleans a view from a form", () => {
    const v = cleanView({ id: "v", name: "  Mine ", source: "items", layout: "kanban", filters: [{ field: "status", op: "is", value: "open" }, { field: "bad field", op: "is" }, { field: "tag", op: "nope" as never }], sort: { field: "due", dir: "sideways" as never }, group: "project" }, "2026-11-26T00:00:00Z");
    expect(v).toMatchObject({ name: "Mine", layout: "kanban", filters: [{ field: "status", op: "is", value: "open" }], sort: { field: "due", dir: "asc" }, group: "project" });
    expect(cleanView({ id: "v", name: "", source: "items" }, "x")).toBeNull();
    expect(cleanView({ id: "v", name: "x", source: "people" as never }, "x")).toBeNull();
  });
});

describe("editor and palette", () => {
  const types = [{ id: "meeting", name: "Meeting note" }, { id: "project", name: "Project" }];
  it("matches /new in the slash menu and reads the line", () => {
    expect(matchTypes("pro", types).map((t) => t.id)).toEqual(["project"]);
    expect(matchTypes("new", types)).toHaveLength(2);
    expect(matchTypes("zz", types)).toEqual([]);
    expect(parseNewLine("- /new project Q4 launch")).toEqual({ indent: "- ", typeId: "project", title: "Q4 launch" });
    expect(parseNewLine("/new meeting")).toEqual({ indent: "", typeId: "meeting", title: "" });
    expect(parseNewLine("/todo x")).toBeNull();
  });

  it("offers tags, views and new notes in ⌘K", () => {
    const d = { tags: [{ tag: "launch", count: 3 }, { tag: "launch/web", count: 1 }, { tag: "ops", count: 1 }], views: [{ id: "v1", name: "Open by project", source: "items" as const }], types };
    expect(paletteRows(d, "#lau").map((r) => r.label)).toEqual(["#launch", "#launch/web"]);
    expect(paletteRows(d, "project").map((r) => r.id)).toEqual(["view-v1", "new-project"]);
    const named = paletteRows(d, "new project Q4 launch").find((r) => r.group === "New note");
    expect(named).toMatchObject({ label: "New project “Q4 launch”", create: { typeId: "project", title: "Q4 launch" } });
    expect(paletteRows(d, "new meeting note standup").find((r) => r.id === "new-meeting")?.create).toEqual({ typeId: "meeting", title: "standup" });
    expect(paletteRows(d, "").filter((r) => r.group === "New note")).toHaveLength(2);
  });
});
