import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lineKey, mergeNotes, rewriteLinks, similarity, type MergeNote } from "@/lib/vault/merge";
import { mergeCandidates, mergeVaultNotes, previewMerge, undoMerge } from "./merge";
import { resetVaultIndexes } from "./vault-index";

const note = (name: string, markdown: string, path = `${name}.md`): MergeNote => ({ path, name, title: markdown.match(/^#\s+(.+)$/m)?.[1] ?? name, markdown });

describe("merging notes, pure", () => {
  it("adds the other note under a From heading, without lines already there", () => {
    const a = note("Standup", "---\ntags: [team]\n---\n# Standup\n\n- [ ] [[item:abc|Send the deck]]\n- Budget is fine\n");
    const b = note("Standup 2", "---\ntags: [ops]\nowner: Nitin\n---\n# Standup 2\n\n- [x] [[item:abc|Send the deck]]\n- budget is fine\n- Hiring opens Monday\n");
    const r = mergeNotes(a, [b]);
    expect(r.skipped).toBe(2);
    expect(r.added).toBe(1);
    expect(r.markdown).toContain("## From Standup 2\n\n- Hiring opens Monday");
    expect(r.markdown.match(/item:abc/g)).toHaveLength(1);
    expect(r.markdown).toMatch(/tags: \[team, ops\]/);
    expect(r.markdown).toContain("owner: Nitin");
    expect(r.markdown).toMatch(/merged_from: \[?"?Standup 2/);
    expect(r.markdown).toMatch(/aliases:/);
    // One front matter, at the top.
    expect(r.markdown.match(/^---$/gm)).toHaveLength(2);
    expect(r.markdown.startsWith("---\n")).toBe(true);
  });

  it("keeps the note that stays when a property clashes, and says so", () => {
    const r = mergeNotes(note("A", "---\nstatus: open\n---\nx text here"), [note("B", "---\nstatus: done\n---\nother text")]);
    expect(r.markdown).toContain("status: open");
    expect(r.conflicts).toEqual([{ key: "status", kept: "open", dropped: "done", from: "B" }]);
  });

  it("keeps code and math blocks whole", () => {
    const r = mergeNotes(note("A", "same line here\n"), [note("B", "```\nsame line here\n```\n\n$$\nsame line here\n$$\n")]);
    expect(r.markdown.match(/same line here/g)).toHaveLength(3);
  });

  it("says when a note adds nothing new", () => {
    const r = mergeNotes(note("A", "# A\n\n- Ship it today\n"), [note("B", "# B\n\n- ship it today\n")]);
    expect(r.emptySources).toEqual(["B"]);
    expect(r.markdown).not.toContain("From B");
  });

  it("matches the same to-do open or ticked, and by item id", () => {
    expect(lineKey("- [ ] Send the deck")).toBe(lineKey("* [x] send  the deck"));
    expect(lineKey("- [[item:x1|Old words]]")).toBe(lineKey("- [ ] [[item:x1|New words]]"));
    expect(lineKey("---")).toBeNull();
    expect(lineKey("## Notes")).toBeNull();
  });

  it("points links at the note that stays, keeping the old name as the label", () => {
    const from = [{ path: "Standup 2.md", name: "Standup 2", title: "Standup 2" }];
    const r = rewriteLinks("See [[Standup 2]], [[Standup 2#Hiring|hiring]], ![[Standup 2]] and [[person:Standup 2]] `[[Standup 2]]`", from, { name: "Standup" });
    expect(r.count).toBe(3);
    expect(r.markdown).toBe("See [[Standup|Standup 2]], [[Standup#Hiring|hiring]], ![[Standup|Standup 2]] and [[person:Standup 2]] `[[Standup 2]]`");
  });

  it("finds a second copy of the same meeting", () => {
    const a = note("Weekly sync 26 Nov", "---\ndate: 2026-11-26\n---\n- Budget review\n- Hiring plan for Q1\n");
    const b = note("Weekly sync (copy)", "---\ndate: 2026-11-26\n---\n- Hiring plan for Q1\n- Office move\n");
    const c = note("Recipes", "- Dal tadka with jeera rice\n");
    expect(similarity(a, b)).toBeGreaterThan(0.5);
    expect(similarity(a, c)).toBeLessThan(0.2);
  });
});

describe("merging notes in a folder", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "db-merge-")); resetVaultIndexes(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });
  const put = (p: string, s: string) => { mkdirSync(join(root, p, ".."), { recursive: true }); writeFileSync(join(root, p), s); };
  const get = (p: string) => readFileSync(join(root, p), "utf8");

  it("merges, relinks, trashes, and undoes", () => {
    put("Standup.md", "# Standup\n\n- Budget is fine\n");
    put("Meetings/Standup copy.md", "# Standup copy\n\n- Budget is fine\n- Hiring opens Monday\n");
    put("Plan.md", "Read [[Standup copy]] first.\n");
    const pv = previewMerge(root, "Standup.md", ["Meetings/Standup copy.md"]);
    expect(pv.relinked).toEqual([{ path: "Plan.md", count: 1 }]);
    expect(existsSync(join(root, "Meetings/Standup copy.md"))).toBe(true);

    const done = mergeVaultNotes(root, "Standup.md", ["Meetings/Standup copy.md"]);
    expect(get("Standup.md")).toContain("## From Standup copy\n\n- Hiring opens Monday");
    expect(get("Plan.md")).toBe("Read [[Standup|Standup copy]] first.\n");
    expect(existsSync(join(root, "Meetings/Standup copy.md"))).toBe(false);
    expect(existsSync(join(root, ".trash/Meetings/Standup copy.md"))).toBe(true);
    expect(mergeCandidates(root, "Standup.md")).toEqual([]);

    const u = undoMerge(root, done.id);
    expect(u.kept).toEqual([]);
    expect(get("Standup.md")).toBe("# Standup\n\n- Budget is fine\n");
    expect(get("Plan.md")).toBe("Read [[Standup copy]] first.\n");
    expect(get("Meetings/Standup copy.md")).toContain("Hiring opens Monday");
    expect(() => undoMerge(root, done.id)).toThrow();
  });

  it("leaves a note edited since the merge as it is on undo", () => {
    put("A.md", "alpha line one\n");
    put("B.md", "beta line two\n");
    const done = mergeVaultNotes(root, "A.md", ["B.md"]);
    writeFileSync(join(root, "A.md"), get("A.md") + "\nmore typed later\n");
    const u = undoMerge(root, done.id);
    expect(u.kept).toEqual(["A.md"]);
    expect(get("A.md")).toContain("more typed later");
    expect(existsSync(join(root, "B.md"))).toBe(true);
  });

  it("won't merge daily pages, or a note into itself", () => {
    put("2026-11-27.md", "# day\n");
    put("A.md", "a\n");
    expect(() => previewMerge(root, "A.md", ["2026-11-27.md"])).toThrow(/Daily pages/);
    expect(() => previewMerge(root, "A.md", ["A.md"])).toThrow(/another note/);
  });

  it("suggests the likely duplicate", () => {
    put("Sync 26 Nov.md", "---\ndate: 2026-11-26\n---\n- Budget review\n- Hiring plan for Q1\n");
    put("Sync 26 Nov 2.md", "---\ndate: 2026-11-26\n---\n- Hiring plan for Q1\n");
    put("Recipes.md", "- Dal\n");
    expect(mergeCandidates(root, "Sync 26 Nov.md").map((c) => c.path)).toEqual(["Sync 26 Nov 2.md"]);
  });
});
