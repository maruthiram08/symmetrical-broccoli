import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { refreshVaultIndex, resetVaultIndexes, searchVault, snippetFor, vaultIndexChanged, vaultTexts } from "./vault-index";

let root: string;
let clock = 1_000_000;
const put = (rel: string, text: string) => {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), text);
  // Distinct mtimes, as a real edit would have.
  const t = new Date(Date.UTC(2026, 10, 1) + (clock += 5000));
  utimesSync(join(root, rel), t, t);
};
const paths = (q: string) => searchVault(root, q).map((h) => h.path);

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "db-vix-")); resetVaultIndexes(); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("full-text search over notes", () => {
  it("finds notes by words in the text, title and file name, with a snippet", () => {
    put("Projects/Alpha launch.md", "# Alpha launch\n\nWe ship the **pricing page** on Monday.\n");
    put("Inbox.md", "- [ ] call the bank about the loan\n");
    put(".obsidian/hidden.md", "pricing secret");
    expect(paths("pricing")).toEqual(["Projects/Alpha launch.md"]);
    expect(paths("alpha")).toEqual(["Projects/Alpha launch.md"]);
    expect(paths("bank loan")).toEqual(["Inbox.md"]);
    expect(paths("pric")).toEqual(["Projects/Alpha launch.md"]); // as you type
    expect(paths("pricinf")).toEqual(["Projects/Alpha launch.md"]); // a typo
    const hit = searchVault(root, "pricing")[0];
    expect(hit.title).toBe("Alpha launch");
    expect(hit.snippet).toBe("We ship the pricing page on Monday.");
    expect(paths("")).toEqual([]);
  });

  it("updates incrementally: only changed notes are read again", () => {
    put("a.md", "apples");
    put("b.md", "bananas");
    expect(refreshVaultIndex(root, { force: true })).toMatchObject({ added: 2, updated: 0, removed: 0, total: 2 });
    expect(refreshVaultIndex(root, { force: true })).toMatchObject({ added: 0, updated: 0, removed: 0 });
    put("a.md", "cherries now");
    unlinkSync(join(root, "b.md"));
    put("c.md", "dates");
    expect(refreshVaultIndex(root, { force: true })).toMatchObject({ added: 1, updated: 1, removed: 1, total: 2 });
    expect(paths("apples")).toEqual([]);
    expect(paths("cherries")).toEqual(["a.md"]);
    expect(paths("bananas")).toEqual([]);
  });

  it("picks up the app's own saves, renames and deletes straight away", () => {
    put("a.md", "first");
    refreshVaultIndex(root, { force: true });
    writeFileSync(join(root, "a.md"), "second");
    const st = statSync(join(root, "a.md"));
    vaultIndexChanged(root, { saved: [{ path: "a.md", mtimeMs: st.mtimeMs, size: st.size }] });
    expect(searchVault(root, "second").map((h) => h.path)).toEqual(["a.md"]);
    vaultIndexChanged(root, { removed: ["a.md"] });
    expect(vaultTexts(root).has("a.md")).toBe(false);
    expect(searchVault(root, "second")).toEqual([]);
  });

  it("follows .gitignore", () => {
    put(".gitignore", "private/\n");
    put("private/p.md", "zebra");
    put("open.md", "zebra");
    expect(paths("zebra")).toEqual(["open.md"]);
  });

  it("writes a snippet around the first match", () => {
    expect(snippetFor("# T\n\n- [ ] Ask [[person:Nitin K]] about the budget\n", ["budget"])).toBe("Ask Nitin K about the budget");
    expect(snippetFor("x".repeat(100) + " needle", ["needle"]).startsWith("…")).toBe(true);
  });
});
