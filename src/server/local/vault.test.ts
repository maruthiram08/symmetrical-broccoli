import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  absIn, cleanRel, createVaultFolder, createVaultNote, folderPaths, isLeftOut, moveVaultEntry, readVaultNote, renameVaultEntry,
  resolveAssetPath, resolveNotePath, safeName, saveVaultNote, trashVaultEntry, treeSignature, walkVault, type TreeNode,
} from "./vault";

let root: string;
const put = (rel: string, text: string | Buffer = "") => { mkdirSync(join(root, rel, ".."), { recursive: true }); writeFileSync(join(root, rel), text); };
const names = (ns: TreeNode[]): unknown[] => ns.map((n) => (n.type === "folder" ? { [n.name]: names(n.children) } : n.name));

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "db-vault-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("paths from the browser", () => {
  it("accepts plain relative paths and refuses anything that could leave the folder or is hidden", () => {
    expect(cleanRel("Projects/Alpha.md")).toBe("Projects/Alpha.md");
    expect(cleanRel("Projects/")).toBe("Projects");
    expect(cleanRel("नोट्स/कल.md")).toBe("नोट्स/कल.md");
    for (const bad of ["../x.md", "a/../../x.md", "/etc/passwd", ".obsidian/app.json", "a/.git/config", "a//b.md", "a\\b.md", "x\0.md", ".trash/old.md"]) expect(cleanRel(bad)).toBeNull();
  });

  it("refuses a symlink that points outside the folder", () => {
    const outside = mkdtempSync(join(tmpdir(), "db-out-"));
    writeFileSync(join(outside, "secret.md"), "secret");
    symlinkSync(outside, join(root, "escape"));
    expect(() => absIn(root, "escape/secret.md")).toThrow();
    expect(readVaultNote(root, "escape/secret.md")).toBeNull();
    expect(walkVault(root).files).toEqual([]);
    rmSync(outside, { recursive: true, force: true });
  });
});

describe("the tree", () => {
  it("lists folders first, then notes, skipping hidden folders, node_modules and non-Markdown", () => {
    put("Zeta.md"); put("alpha.md"); put("Projects/Beta.md"); put("Projects/Sub/Gamma.md"); put("Projects/pic.png");
    put(".obsidian/app.json", "{}"); put(".git/HEAD"); put(".trash/Old.md"); put(".daily-brief/state.json", "{}");
    put("node_modules/x/README.md"); put("notes.txt"); put("Empty/.keep");
    const { tree, files } = walkVault(root);
    expect(names(tree)).toEqual([{ Empty: [] }, { Projects: [{ Sub: ["Gamma.md"] }, "Beta.md"] }, "alpha.md", "Zeta.md"]);
    expect(files.map((f) => f.path).sort()).toEqual(["Projects/Beta.md", "Projects/Sub/Gamma.md", "Zeta.md", "alpha.md"]);
    expect(folderPaths(tree)).toEqual(["", "Empty", "Projects", "Projects/Sub"]);
  });

  it("respects .gitignore files, at the top and in subfolders", () => {
    put(".gitignore", "drafts/\n*.tmp.md\n!keep.tmp.md\n");
    put("drafts/a.md"); put("x.tmp.md"); put("keep.tmp.md"); put("ok.md");
    put("Work/.gitignore", "private.md\n"); put("Work/private.md"); put("Work/public.md");
    expect(walkVault(root).files.map((f) => f.path).sort()).toEqual(["Work/public.md", "keep.tmp.md", "ok.md"]);
    expect(isLeftOut(root, "drafts/a.md")).toBe(true);
    expect(isLeftOut(root, "Work/private.md")).toBe(true);
    expect(isLeftOut(root, "Work/public.md")).toBe(false);
  });

  it("respects Obsidian's Excluded files (prefixes and /regexes/)", () => {
    put(".obsidian/app.json", JSON.stringify({ userIgnoreFilters: ["Archive/", "/^Templates/.*\\.md$/"] }));
    put("Archive/old.md"); put("Templates/day.md"); put("Notes/now.md");
    expect(walkVault(root).files.map((f) => f.path)).toEqual(["Notes/now.md"]);
  });

  it("changes its signature when a note is added, edited or removed", () => {
    put("a.md", "one");
    const s1 = treeSignature(walkVault(root).files);
    expect(treeSignature(walkVault(root).files)).toBe(s1);
    writeFileSync(join(root, "a.md"), "one two");
    const s2 = treeSignature(walkVault(root).files);
    expect(s2).not.toBe(s1);
    put("b.md");
    expect(treeSignature(walkVault(root).files)).not.toBe(s2);
  });
});

describe("reading and saving", () => {
  const FIXTURES = [
    "---\naliases: [x]\n---\n# Obsidian note\n\n![[Other note]] and ==marked== text[^1].\n\n[^1]: A footnote.\n",
    "crlf\r\nfile\r\n", "no trailing newline", "﻿BOM first", "trailing   \n\n\n", "",
    "```mermaid\ngraph TD\n  A-->B\n```\n",
  ];

  it("keeps every byte, and saves only what changed", () => {
    put("n.md", "start");
    let base = readVaultNote(root, "n.md")!.hash;
    for (const md of FIXTURES) {
      const r = saveVaultNote(root, "n.md", md, base);
      expect(r.ok).toBe(true);
      if (r.ok) base = r.hash;
      expect(readFileSync(join(root, "n.md"), "utf8")).toBe(md);
      expect(readVaultNote(root, "n.md")!.markdown).toBe(md);
    }
  });

  it("never rewrites a file whose text didn't change", () => {
    put("same.md", "# Same\r\n");
    const old = new Date("2020-01-01T00:00:00Z");
    utimesSync(join(root, "same.md"), old, old);
    const n = readVaultNote(root, "same.md")!;
    const r = saveVaultNote(root, "same.md", n.markdown, n.hash);
    expect(r).toMatchObject({ ok: true, written: false });
    expect(statSync(join(root, "same.md")).mtimeMs).toBe(old.getTime());
  });

  it("opens a file that isn't valid UTF-8 read-only, and refuses to save it", () => {
    const bytes = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]); // "café" in Latin-1
    put("latin1.md", bytes);
    const n = readVaultNote(root, "latin1.md")!;
    expect(n.readOnly).toBe(true);
    expect(saveVaultNote(root, "latin1.md", "x", n.hash).ok).toBe(false);
    expect(readFileSync(join(root, "latin1.md")).equals(bytes)).toBe(true);
  });

  it("keeps the other app's version as a conflict copy, next to the note", () => {
    put("Work/plan.md", "v1");
    const opened = readVaultNote(root, "Work/plan.md")!.hash;
    writeFileSync(join(root, "Work/plan.md"), "edited in Obsidian");
    const r = saveVaultNote(root, "Work/plan.md", "mine", opened, new Date("2026-11-26T10:00:00Z"));
    expect(r).toMatchObject({ ok: true, conflict: "Work/plan.conflict-2026-11-26T10-00-00-000Z.md" });
    expect(readFileSync(join(root, "Work/plan.conflict-2026-11-26T10-00-00-000Z.md"), "utf8")).toBe("edited in Obsidian");
    expect(readFileSync(join(root, "Work/plan.md"), "utf8")).toBe("mine");
  });

  it("keeps the file's permissions when saving", () => {
    put("p.md", "x");
    chmodSync(join(root, "p.md"), 0o640);
    saveVaultNote(root, "p.md", "y", null);
    expect(statSync(join(root, "p.md")).mode & 0o777).toBe(0o640);
  });

  it("only reads and writes .md notes", () => {
    put("a.txt", "x");
    expect(readVaultNote(root, "a.txt")).toBeNull();
    expect(saveVaultNote(root, "a.txt", "y", null).ok).toBe(false);
    expect(saveVaultNote(root, "../out.md", "y", null).ok).toBe(false);
  });
});

describe("file operations", () => {
  it("creates notes and folders with free names", () => {
    expect(createVaultNote(root, "", "Plan")).toBe("Plan.md");
    expect(createVaultNote(root, "", "Plan")).toBe("Plan 2.md");
    expect(createVaultFolder(root, "", "Work")).toBe("Work");
    expect(createVaultNote(root, "Work", "a/b: c?")).toBe("Work/a b c.md");
    expect(readFileSync(join(root, "Plan.md"), "utf8")).toBe("");
    expect(() => createVaultNote(root, "Nope", "x")).toThrow();
    expect(safeName("..hidden")).toBe("hidden");
    expect(safeName("   ")).toBe("Untitled");
  });

  it("renames and moves notes and folders, never overwriting", () => {
    put("a.md", "A"); put("b.md", "B"); put("Work/c.md", "C"); mkdirSync(join(root, "Archive"));
    expect(renameVaultEntry(root, "a.md", "Alpha")).toBe("Alpha.md");
    expect(() => renameVaultEntry(root, "Alpha.md", "b.md")).toThrow(/already exists/);
    expect(moveVaultEntry(root, "Alpha.md", "Work")).toBe("Work/Alpha.md");
    expect(moveVaultEntry(root, "Work", "Archive")).toBe("Archive/Work");
    expect(readFileSync(join(root, "Archive/Work/Alpha.md"), "utf8")).toBe("A");
    expect(() => moveVaultEntry(root, "Archive", "Archive/Work")).toThrow(/inside itself/);
    expect(moveVaultEntry(root, "Archive/Work/c.md", "")).toBe("c.md");
  });

  it("deletes into .trash, keeping the path and never replacing an earlier delete", () => {
    put("Work/plan.md", "1");
    expect(trashVaultEntry(root, "Work/plan.md")).toBe(".trash/Work/plan.md");
    put("Work/plan.md", "2");
    expect(trashVaultEntry(root, "Work/plan.md")).toBe(".trash/Work/plan 2.md");
    expect(readFileSync(join(root, ".trash/Work/plan.md"), "utf8")).toBe("1");
    expect(existsSync(join(root, "Work/plan.md"))).toBe(false);
    // The folder's earlier delete already made .trash/Work, so this one is "Work 2".
    expect(trashVaultEntry(root, "Work")).toBe(".trash/Work 2");
    expect(walkVault(root).files).toEqual([]);
  });
});

describe("finding notes from links", () => {
  it("resolves paths, slugs in notes/ and bare Obsidian names", () => {
    put("notes/q4-plan.md", "# Q4"); put("Projects/Alpha.md"); put("Deep/Er/Alpha.md"); put("Inbox.md");
    expect(resolveNotePath(root, "q4-plan")).toBe("notes/q4-plan.md");
    expect(resolveNotePath(root, "Projects/Alpha")).toBe("Projects/Alpha.md");
    expect(resolveNotePath(root, "Projects/Alpha.md")).toBe("Projects/Alpha.md");
    expect(resolveNotePath(root, "alpha")).toBe("Projects/Alpha.md");
    expect(resolveNotePath(root, "Inbox#Heading")).toBe("Inbox.md");
    expect(resolveNotePath(root, "Nope")).toBeNull();
    expect(resolveNotePath(root, "../etc/passwd")).toBeNull();
  });

  it("finds an image by name for ![[picture.png]]", () => {
    put("attachments/Pasted image.png", "png"); put("Work/diagram.svg", "<svg/>");
    expect(resolveAssetPath(root, "Pasted image.png")).toBe("attachments/Pasted image.png");
    expect(resolveAssetPath(root, "diagram.svg", "Work")).toBe("Work/diagram.svg");
    expect(resolveAssetPath(root, "missing.png")).toBeNull();
    expect(resolveAssetPath(root, "notes.md")).toBeNull();
  });
});
