import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SAMPLE_BRIEF } from "@/lib/templates/kinds";
import type { BriefModel } from "@/lib/types";
import { writeAtomic } from "./atomic";
import { FileStore } from "./file-store";
import { mirroredFiles, syncFolder, syncFolderProblem } from "./folder-sync";
import { commitFiles, gitReason, isGitRepo, pushTo } from "./git-sync";
import { afterPublish, renderDailyFor, renderDecisionsFor } from "./outputs";
import { publishLocal } from "./publish";
import { readSyncStatus } from "./sync-status";
import { loadTemplate, resetTemplate, saveTemplate, templatePath } from "./templates";
import type { Workspace } from "./workspaces";

const tmp = () => mkdtempSync(join(tmpdir(), "db-sync-"));
const ws = (path: string, over: Partial<Workspace> = {}): Workspace => ({ id: "w", name: "W", path, ...over });
const sh = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });

function repo(): string {
  const dir = tmp();
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "commit.gpgsign", "false");
  return dir;
}

function notes(dir: string) {
  writeFileSync(join(dir, "2026-11-25.md"), "# 25\n");
  writeFileSync(join(dir, "2026-11-26.md"), "# 26\n");
  writeFileSync(join(dir, "decisions.md"), "# Decisions\n");
  writeFileSync(join(dir, "week-2026-W48.md"), "# Week\n");
  writeFileSync(join(dir, "my own note.md"), "mine\n");
  mkdirSync(join(dir, "people"));
  writeFileSync(join(dir, "people", "Nitin.md"), "# Nitin\n");
  mkdirSync(join(dir, ".daily-brief"));
  writeFileSync(join(dir, ".daily-brief", "state.json"), "{}");
}

describe("atomic writes", () => {
  it("writes through a temp file and skips unchanged content", () => {
    const p = join(tmp(), "a", "b.md");
    expect(writeAtomic(p, "x")).toBe(true);
    expect(writeAtomic(p, "x")).toBe(false);
    expect(writeAtomic(p, "y")).toBe(true);
    expect(readFileSync(p, "utf8")).toBe("y");
    expect(readdirSync(join(p, "..")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("folder sync", () => {
  it("mirrors only the notes into daily-brief/, never app data or your other files", () => {
    const src = tmp(), vault = tmp();
    notes(src);
    writeFileSync(join(vault, "Inbox.md"), "vault note\n");
    expect(mirroredFiles(src)).toEqual(["2026-11-25.md", "2026-11-26.md", "decisions.md", "people/Nitin.md", "week-2026-W48.md"]);
    const r = syncFolder(ws(src), vault);
    expect(r).toMatchObject({ copied: 5, unchanged: 0, removed: 0 });
    expect(readFileSync(join(vault, "daily-brief", "people", "Nitin.md"), "utf8")).toBe("# Nitin\n");
    expect(existsSync(join(vault, "daily-brief", ".daily-brief"))).toBe(false);
    expect(existsSync(join(vault, "daily-brief", "my own note.md"))).toBe(false);
    expect(readFileSync(join(vault, "Inbox.md"), "utf8")).toBe("vault note\n");

    expect(syncFolder(ws(src), vault)).toMatchObject({ copied: 0, unchanged: 5 });
  });

  it("removes only files it mirrored before, and only inside daily-brief/", () => {
    const src = tmp(), vault = tmp();
    notes(src);
    syncFolder(ws(src), vault);
    writeFileSync(join(vault, "daily-brief", "people", "My notes on Priya.md"), "keep me\n");
    writeFileSync(join(vault, "daily-brief", "2026-01-01.md"), "I made this\n");
    execFileSync("rm", [join(src, "people", "Nitin.md")]);
    const r = syncFolder(ws(src), vault);
    expect(r.removed).toBe(1);
    expect(existsSync(join(vault, "daily-brief", "people", "Nitin.md"))).toBe(false);
    expect(readFileSync(join(vault, "daily-brief", "people", "My notes on Priya.md"), "utf8")).toBe("keep me\n");
    expect(readFileSync(join(vault, "daily-brief", "2026-01-01.md"), "utf8")).toBe("I made this\n");
  });

  it("ignores a tampered manifest that points outside daily-brief/", () => {
    const src = tmp(), vault = tmp();
    notes(src);
    syncFolder(ws(src), vault);
    writeFileSync(join(vault, "keep.md"), "x");
    writeFileSync(join(vault, "daily-brief", ".daily-brief-sync.json"), JSON.stringify({ files: ["../keep.md", "/etc/hosts", "people/../../keep.md"] }));
    syncFolder(ws(src), vault);
    expect(existsSync(join(vault, "keep.md"))).toBe(true);
  });

  it("refuses folders that don't exist or sit inside the notes folder", () => {
    const src = tmp();
    expect(syncFolderProblem(ws(src), join(src, "nope"))).toMatch(/doesn't exist/);
    mkdirSync(join(src, "inner"));
    expect(syncFolderProblem(ws(src), join(src, "inner"))).toMatch(/outside/);
    expect(syncFolderProblem(ws(src), src)).toMatch(/outside/);
    const parent = tmp();
    const nested = join(parent, "daily-brief");
    mkdirSync(nested);
    expect(syncFolderProblem(ws(nested), parent)).toMatch(/already/);
    expect(syncFolderProblem(ws(src), tmp())).toBeNull();
    expect(() => syncFolder(ws(src), "")).toThrow(/Pick a folder/);
  });
});

describe("git sync", () => {
  it("knows a repo from a plain folder", async () => {
    expect(await isGitRepo(repo())).toBe(true);
    expect(await isGitRepo(join(tmp(), "missing"))).toBe(false);
  });

  it("commits only the brief's files, then nothing when unchanged", async () => {
    const dir = repo();
    writeFileSync(join(dir, "2026-11-26.md"), "# 26\n");
    writeFileSync(join(dir, "scratch.md"), "not mine to commit\n");
    const c = await commitFiles(dir, ["2026-11-26.md", "missing.md"], "Daily brief 2026-11-26");
    expect(c.status).toBe("committed");
    expect(sh(dir, "log", "--format=%s").trim()).toBe("Daily brief 2026-11-26");
    expect(sh(dir, "show", "--name-only", "--format=", "HEAD").trim()).toBe("2026-11-26.md");
    expect(sh(dir, "status", "--porcelain").trim()).toBe("?? scratch.md");
    expect((await commitFiles(dir, ["2026-11-26.md"], "again")).status).toBe("nothing");
  });

  it("leaves your other staged changes staged", async () => {
    const dir = repo();
    writeFileSync(join(dir, "other.md"), "x");
    sh(dir, "add", "other.md");
    writeFileSync(join(dir, "2026-11-26.md"), "# 26\n");
    expect((await commitFiles(dir, ["2026-11-26.md"], "Daily brief 2026-11-26")).status).toBe("committed");
    expect(sh(dir, "status", "--porcelain").trim()).toBe("A  other.md");
  });

  it("pushes to a named remote and refuses URLs or unknown remotes", async () => {
    const dir = repo();
    const bare = tmp();
    execFileSync("git", ["init", "-q", "--bare", bare]);
    sh(dir, "remote", "add", "origin", bare);
    writeFileSync(join(dir, "2026-11-26.md"), "# 26\n");
    await commitFiles(dir, ["2026-11-26.md"], "Daily brief 2026-11-26");
    expect(await pushTo(dir, "origin")).toEqual({ status: "pushed" });
    expect(execFileSync("git", ["-C", bare, "log", "--format=%s", "main"], { encoding: "utf8" }).trim()).toBe("Daily brief 2026-11-26");
    expect(await pushTo(dir, "https://x:ghp_secret@github.com/a/b")).toMatchObject({ status: "failed", reason: expect.stringMatching(/remote's name/) });
    expect(await pushTo(dir, "backup")).toMatchObject({ status: "failed", reason: expect.stringMatching(/no remote called backup/) });
  });

  it("keeps URLs and tokens out of error text", () => {
    expect(gitReason({ code: 128, stdout: "", stderr: "fatal: unable to access 'https://user:ghp_abc123@github.com/x/y.git/': 403\n" }))
      .toBe("fatal: unable to access '<url> 403");
    expect(gitReason({ code: 1, stdout: "", stderr: "error: token ghp_abcdef123 rejected" })).toBe("error: token <token> rejected");
  });
});

describe("templates in the workspace", () => {
  it("saves, refuses broken ones, and resets", () => {
    const w = ws(tmp());
    expect(loadTemplate(w, "daily")).toBeNull();
    expect(saveTemplate(w, "daily", "# {{dateLabel}}\n")).toEqual({ ok: true });
    expect(loadTemplate(w, "daily")).toBe("# {{dateLabel}}\n");
    expect(saveTemplate(w, "daily", "{{#if x}}")).toMatchObject({ ok: false, error: expect.stringMatching(/never closed/) });
    expect(loadTemplate(w, "daily")).toBe("# {{dateLabel}}\n");
    resetTemplate(w, "daily");
    expect(existsSync(templatePath(w, "daily"))).toBe(false);
  });
});

async function seeded(dir: string) {
  const store = new FileStore(join(dir, ".daily-brief", "state.json"));
  const user = store.addUser({ email: "you@this-mac", name: "Maruthi", timeZone: "Asia/Kolkata" });
  const { meeting } = await store.upsertMeeting({ userId: user.id, providerMeetingId: "p1", title: "Growth standup", startedAt: "2026-11-26T05:00:00Z", participants: ["Nitin", "Maruthi"] });
  await store.commitExtraction({ meetingId: meeting.id, userId: user.id, at: "2026-11-26T06:00:00Z", closes: [], newItems: [
    { kind: "owe", text: "Send Nitin the banner text", person: "Nitin", quote: "I'll send it", meetingId: meeting.id, dueAt: null },
    { kind: "decision", text: "Ship on Friday", person: null, quote: "ship Friday", meetingId: meeting.id, dueAt: null },
  ] });
  const items = await store.listItems(user.id);
  const owe = items.find((i) => i.kind === "owe")!, dec = items.find((i) => i.kind === "decision")!;
  const model: BriefModel = {
    ...SAMPLE_BRIEF, userId: user.id, stillOpen: [], stillOpenCount: 0, waitingOn: [], closedToday: [], tomorrow: undefined,
    youOwe: [{ ...SAMPLE_BRIEF.youOwe[1], itemId: owe.id, meetingId: meeting.id, starred: false }],
    decisions: [{ ...SAMPLE_BRIEF.decisions[0], itemId: dec.id, meetingId: meeting.id, text: "Ship on Friday", quote: "ship Friday" }],
  };
  return { store, user, model, meeting };
}

describe("after a brief", () => {
  it("writes linked notes, person and meeting pages, mirrors them and commits", async () => {
    const dir = repo(), vault = tmp();
    const w = ws(dir, { sync: { folder: vault, enabled: true } });
    const { store, user, model } = await seeded(dir);
    const md = await renderDailyFor(w, store, model);
    expect(md).toContain("Send [[Nitin]] the final banner text");
    expect(md).toContain("[[2026-11-26 Growth standup|Growth standup]]");
    await publishLocal(dir, user, model, md, () => {}, undefined, await renderDecisionsFor(w, store, model));
    const files = await afterPublish(w, store, user, model, undefined, new Date("2026-11-26T12:00:00Z"));
    expect(files).toEqual(expect.arrayContaining(["2026-11-26.md", "decisions.md", "people/Nitin.md", "meetings/2026-11-26 Growth standup.md"]));
    expect(existsSync(join(dir, "people", "Maruthi.md"))).toBe(false); // never a page for you
    expect(readFileSync(join(dir, "decisions.md"), "utf8")).toMatch(/^- \[\[2026-11-26\]\] · Ship on Friday .* \^d-\w+$/m);
    expect(readFileSync(join(dir, "meetings", "2026-11-26 Growth standup.md"), "utf8")).toContain("with [[Nitin]]");
    expect(readFileSync(join(vault, "daily-brief", "people", "Nitin.md"), "utf8")).toContain("# Nitin");
    expect(sh(dir, "log", "--format=%s").trim()).toBe("Daily brief 2026-11-26");
    expect(sh(dir, "show", "--name-only", "--format=", "HEAD")).not.toContain(".daily-brief");
    const status = readSyncStatus(w);
    expect(status.folder?.ok).toBe(true);
    expect(status.git).toMatchObject({ ok: true, detail: expect.stringMatching(/^Committed/) });
    expect(status.push).toBeUndefined(); // off by default

    // A second publish the same day doesn't duplicate the decisions.
    await publishLocal(dir, user, model, md, () => {}, undefined, await renderDecisionsFor(w, store, model));
    expect(readFileSync(join(dir, "decisions.md"), "utf8").match(/Ship on Friday/g)).toHaveLength(1);
  });

  it("gives every meeting its own note, even two with the same title on one day", async () => {
    const dir = tmp();
    const w = ws(dir);
    const { store, user, model } = await seeded(dir);
    await store.upsertMeeting({ userId: user.id, providerMeetingId: "p2", title: "Growth standup", startedAt: "2026-11-26T09:00:00Z", participants: [] });
    await store.upsertMeeting({ userId: user.id, providerMeetingId: "p3", title: "Old: sync/plan", startedAt: "2026-11-02T09:00:00Z", participants: [] });
    await afterPublish(w, store, user, model);
    expect(readdirSync(join(dir, "meetings")).sort()).toEqual(["2026-11-02 Old sync plan.md", "2026-11-26 Growth standup (2).md", "2026-11-26 Growth standup.md"]);
  });

  it("with links off, writes the plain notes and no extra pages; no repo, no git", async () => {
    const dir = tmp();
    const w = ws(dir, { links: false });
    const { store, user, model } = await seeded(dir);
    const md = await renderDailyFor(w, store, model);
    expect(md).not.toContain("[[");
    await afterPublish(w, store, user, model);
    expect(existsSync(join(dir, "people"))).toBe(false);
    expect(readSyncStatus(w).git).toBeUndefined();
  });

  it("a broken template never stops the brief: the default is used and Settings says why", async () => {
    const dir = tmp();
    const w = ws(dir, { links: false });
    const { store, model } = await seeded(dir);
    writeAtomic(templatePath(w, "daily"), "{{#each youOwe}}never closed");
    const md = await renderDailyFor(w, store, model);
    expect(md).toContain("## You owe");
    expect(readSyncStatus(w).template?.detail).toMatch(/daily template: Line 1/);
  });

  it("a failed commit (no git identity) is recorded, not thrown", async () => {
    const dir = tmp();
    execFileSync("git", ["init", "-q", dir]);
    const w = ws(dir, { links: false });
    const { store, user, model } = await seeded(dir);
    writeFileSync(join(dir, "2026-11-26.md"), "# x\n");
    const env = { ...process.env };
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    process.env.GIT_AUTHOR_NAME = ""; process.env.GIT_COMMITTER_NAME = "";
    process.env.GIT_AUTHOR_EMAIL = ""; process.env.GIT_COMMITTER_EMAIL = "";
    process.env.EMAIL = "";
    try {
      await afterPublish(w, store, user, model);
    } finally {
      for (const k of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_AUTHOR_NAME", "GIT_COMMITTER_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_EMAIL", "EMAIL"]) {
        if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k];
      }
    }
    expect(readSyncStatus(w).git?.ok).toBe(false);
  });
});
