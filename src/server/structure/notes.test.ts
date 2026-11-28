import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TYPES } from "@/lib/structure/note-types";
import { readPage, savePage } from "@/server/local/pages";
import { loadNoteTypes, noteTypesPath, saveNoteTypes } from "./note-types";
import { createTypedNote, noteRows, projectRows, resolveProject, setNoteProperties } from "./notes";

let dir: string;
const before = process.env.DAILY_BRIEF_DIR;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "db-structure-notes-")); process.env.DAILY_BRIEF_DIR = dir; });
afterEach(() => { if (before === undefined) delete process.env.DAILY_BRIEF_DIR; else process.env.DAILY_BRIEF_DIR = before; });

describe("note types file", () => {
  it("uses the defaults until saved, then the file in .daily-brief", () => {
    expect(loadNoteTypes(join(dir, ".daily-brief"))).toEqual({ types: DEFAULT_TYPES, error: null, custom: false });
    saveNoteTypes([{ id: "", name: "Recipe", properties: [{ key: "serves", type: "number" }], template: "## Steps\n" }], join(dir, ".daily-brief"));
    const p = noteTypesPath(join(dir, ".daily-brief"));
    expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({ version: 1, types: [{ id: "recipe", name: "Recipe", properties: [{ key: "serves", type: "number" }], template: "## Steps\n" }] });
    writeFileSync(p, "{ not json");
    const bad = loadNoteTypes(join(dir, ".daily-brief"));
    expect(bad.types).toBe(DEFAULT_TYPES);
    expect(bad.error).toMatch(/couldn't be read/);
  });
});

describe("typed notes, properties and projects", () => {
  it("makes a note of a type and indexes its properties and tags", () => {
    const project = DEFAULT_TYPES.find((t) => t.id === "project")!;
    const { slug } = createTypedNote(project, "Q4 launch", "2026-11-26", dir);
    expect(slug).toBe("q4-launch");
    savePage(slug, readPage(slug, dir)!.markdown.replace("## Goal", "## Goal\n\nShip it #launch/web"), null, dir);
    const [row] = noteRows(dir, DEFAULT_TYPES);
    expect(row).toMatchObject({ slug, title: "Q4 launch", type: "project", typeName: "Project", tags: ["launch/web"], props: { status: "active" } });
    expect(projectRows(noteRows(dir, DEFAULT_TYPES)).map((p) => p.slug)).toEqual(["q4-launch"]);
  });

  it("changes one property on disk and leaves every other byte", () => {
    const md = "---\r\n# mine\r\ntype: Project\r\nstatus: active\r\nweird:\r\n  nested: map\r\n---\r\n# Plan\r\n\r\nBody\r\n";
    savePage("plan", md, null, dir);
    const r = setNoteProperties("plan", { status: "done" }, dir);
    expect(r?.ok).toBe(true);
    expect(readFileSync(join(dir, "notes", "plan.md"), "utf8")).toBe(md.replace("status: active", "status: done"));
    // Same value again: the file isn't written.
    expect(setNoteProperties("plan", { status: "done" }, dir)).toMatchObject({ ok: true });
    expect(setNoteProperties("missing", { a: 1 }, dir)).toBeNull();
  });

  it("resolves +project to an existing project, a note, or a new project", () => {
    const project = DEFAULT_TYPES.find((t) => t.id === "project")!;
    createTypedNote(project, "Q4 launch", "2026-11-26", dir);
    expect(resolveProject("q4-launch", "Asia/Kolkata", dir)).toBe("q4-launch");
    expect(resolveProject("Q4", "Asia/Kolkata", dir)).toBe("q4-launch"); // prefix of a project
    savePage("hiring", "# Hiring\n", null, dir);
    expect(resolveProject("hiring", "Asia/Kolkata", dir)).toBe("hiring");
    expect(readPage("hiring", dir)!.markdown).toBe("---\ntype: Project\n---\n# Hiring\n");
    expect(resolveProject("office-move", "Asia/Kolkata", dir)).toBe("office-move");
    expect(existsSync(join(dir, "notes", "office-move.md"))).toBe(true);
    expect(readPage("office-move", dir)!.title).toBe("Office move");
    expect(resolveProject("  ", "Asia/Kolkata", dir)).toBeNull();
  });
});
