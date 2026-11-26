import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activePath, closeTab, cycleTab, emptyLayout, loadLayout, newTab, noteHref, openPath, openToSide, pathFromHref, removePath,
  renamePath, sanitizeLayout, saveLayout, toggleSplit, type Layout,
} from "./layout";

const tabs = (l: Layout) => l.panes.map((p) => p.tabs.map((t, i) => (i === p.active ? `[${t}]` : t)).join(" "));

describe("tabs", () => {
  it("opens notes in the current tab, or a new one, and switches to one already open", () => {
    let l = openPath(emptyLayout(), "a.md");
    l = openPath(l, "b.md");
    expect(tabs(l)).toEqual(["[b.md]"]);
    l = openPath(l, "c.md", { newTab: true });
    expect(tabs(l)).toEqual(["b.md [c.md]"]);
    l = openPath(l, "b.md");
    expect(tabs(l)).toEqual(["[b.md] c.md"]);
  });

  it("⌘T adds a blank tab, ⌘W closes, ⌃Tab cycles", () => {
    let l = openPath(openPath(emptyLayout(), "a.md"), "b.md", { newTab: true });
    l = newTab(l);
    expect(tabs(l)).toEqual(["a.md b.md []"]);
    l = openPath(l, "c.md");
    expect(tabs(l)).toEqual(["a.md b.md [c.md]"]);
    l = cycleTab(l, 1);
    expect(activePath(l)).toBe("a.md");
    l = cycleTab(l, -1);
    expect(activePath(l)).toBe("c.md");
    l = closeTab(l);
    expect(tabs(l)).toEqual(["a.md [b.md]"]);
    l = closeTab(closeTab(l));
    expect(tabs(l)).toEqual([""]);
    expect(activePath(l)).toBeNull();
  });
});

describe("split panes", () => {
  it("⌘\\ splits with the current note on the right, and joins back", () => {
    let l = openPath(emptyLayout(), "a.md");
    l = toggleSplit(l);
    expect(tabs(l)).toEqual(["[a.md]", "[a.md]"]);
    expect(l.focus).toBe(1);
    l = openPath(l, "b.md");
    expect(tabs(l)).toEqual(["[a.md]", "[b.md]"]);
    l = toggleSplit(l);
    expect(tabs(l)).toEqual(["a.md [b.md]"]);
  });

  it("opens a note to the side, and closing the last tab of a pane closes it", () => {
    let l = openToSide(openPath(emptyLayout(), "a.md"), "b.md");
    expect(tabs(l)).toEqual(["[a.md]", "[b.md]"]);
    l = closeTab(l, 1);
    expect(tabs(l)).toEqual(["[a.md]"]);
  });

  it("follows renames and deletes, including whole folders", () => {
    let l = openPath(openPath(emptyLayout(), "Work/a.md"), "Work/b.md", { newTab: true });
    l = openToSide(l, "c.md");
    l = renamePath(l, "Work", "Archive/Work");
    expect(tabs(l)).toEqual(["Archive/Work/a.md [Archive/Work/b.md]", "[c.md]"]);
    l = removePath(l, "Archive/Work");
    expect(tabs(l)).toEqual(["[c.md]"]);
  });
});

describe("remembering the layout", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("saves per workspace and loads it back", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) });
    const l = toggleSplit(openPath(emptyLayout(), "a.md"));
    saveLayout("ws1", l);
    expect(loadLayout("ws1")).toEqual(l);
    expect(loadLayout("ws2")).toEqual(emptyLayout());
  });

  it("survives storage that throws, or garbage in it", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    expect(loadLayout("ws")).toEqual(emptyLayout());
    expect(() => saveLayout("ws", emptyLayout())).not.toThrow();
    expect(sanitizeLayout({ panes: [{ tabs: ["../x.md", ".obsidian/a.md", "ok.md", "ok.md", 4], active: 9 }], focus: 7 })).toEqual({ panes: [{ tabs: ["ok.md"], active: 0 }], focus: 0 });
    expect(sanitizeLayout("nonsense")).toEqual(emptyLayout());
  });
});

describe("note URLs", () => {
  it("keeps /notes/<slug> for pages in notes/, and paths for the rest", () => {
    expect(noteHref("notes/q4-plan.md")).toBe("/notes/q4-plan");
    expect(noteHref("Projects/Alpha launch.md")).toBe("/notes/Projects/Alpha%20launch.md");
    expect(pathFromHref("/notes/Projects/Alpha%20launch.md")).toBe("Projects/Alpha launch.md");
    expect(pathFromHref("/notes/Projects%2FAlpha")).toBe("Projects/Alpha");
    expect(pathFromHref("/people/x")).toBeNull();
  });
});
