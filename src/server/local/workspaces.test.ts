import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activeWorkspace, addWorkspace, currentWorkspace, getWorkspace, HOME_ID, homeDir, listWorkspaces, registryPath,
  removeWorkspace, setActiveWorkspace, updateWorkspace, withWorkspace,
} from "./workspaces";
import { dataDir, notesDir } from "./paths";

const tmp = () => mkdtempSync(join(tmpdir(), "db-ws-"));
const prev = process.env.DAILY_BRIEF_DIR;
let home: string;

beforeEach(() => {
  home = tmp();
  process.env.DAILY_BRIEF_DIR = home;
});
afterEach(() => {
  if (prev === undefined) delete process.env.DAILY_BRIEF_DIR;
  else process.env.DAILY_BRIEF_DIR = prev;
});

describe("workspaces", () => {
  it("without a list, the only workspace is DAILY_BRIEF_DIR, exactly as before", () => {
    expect(homeDir()).toBe(home);
    expect(listWorkspaces()).toEqual([{ id: HOME_ID, name: "Daily Brief", path: home }]);
    expect(notesDir()).toBe(home);
    expect(dataDir()).toBe(join(home, ".daily-brief"));
    expect(existsSync(registryPath())).toBe(false); // nothing written just by looking
  });

  it("adds, switches (remembered on disk), renames and removes without deleting files", () => {
    const folder = join(tmp(), "Side project");
    const ws = addWorkspace("Side project", folder);
    expect(existsSync(folder)).toBe(true);
    expect(listWorkspaces().map((w) => w.name)).toEqual(["Daily Brief", "Side project"]);
    expect(activeWorkspace().id).toBe(HOME_ID);

    setActiveWorkspace(ws.id);
    expect(notesDir()).toBe(folder);
    expect(JSON.parse(readFileSync(registryPath(), "utf8")).active).toBe(ws.id);

    updateWorkspace(ws.id, { name: "Side" });
    expect(getWorkspace(ws.id)?.name).toBe("Side");

    writeFileSync(join(folder, "2026-11-26.md"), "# mine\n");
    removeWorkspace(ws.id);
    expect(activeWorkspace().id).toBe(HOME_ID);
    expect(readFileSync(join(folder, "2026-11-26.md"), "utf8")).toBe("# mine\n");
    expect(() => removeWorkspace(HOME_ID)).toThrow(/can't be removed/);
  });

  it("refuses duplicates, empty names, files and folders inside app data", () => {
    const folder = tmp();
    addWorkspace("Work", folder);
    expect(() => addWorkspace("Again", folder)).toThrow(/already the workspace/);
    expect(() => addWorkspace("  ", tmp())).toThrow(/name/);
    expect(() => addWorkspace("Data", join(home, ".daily-brief", "x"))).toThrow(/outside/);
    const file = join(tmp(), "f.txt");
    writeFileSync(file, "x");
    expect(() => addWorkspace("File", file)).toThrow(/file/);
  });

  it("withWorkspace pins code to one workspace whatever is active", async () => {
    const a = addWorkspace("A", tmp());
    const b = addWorkspace("B", tmp());
    setActiveWorkspace(a.id);
    const seen = await withWorkspace(b, async () => {
      await new Promise((r) => setTimeout(r, 5));
      setActiveWorkspace(HOME_ID); // a switch meanwhile doesn't move this run
      return notesDir();
    });
    expect(seen).toBe(b.path);
    expect(currentWorkspace().id).toBe(HOME_ID);
  });

  it("the home workspace follows DAILY_BRIEF_DIR and a damaged list falls back to it", () => {
    addWorkspace("A", tmp());
    writeFileSync(registryPath(), "{ not json");
    expect(listWorkspaces().map((w) => w.id)).toEqual([HOME_ID]);
    expect(activeWorkspace().path).toBe(home);
  });

  it("keeps sync, git and link settings per workspace", () => {
    const a = addWorkspace("A", tmp());
    updateWorkspace(a.id, { links: false, git: { push: true } });
    updateWorkspace(a.id, { git: { remote: "backup" } });
    expect(getWorkspace(a.id)).toMatchObject({ links: false, git: { push: true, remote: "backup" } });
    expect(getWorkspace(HOME_ID)?.git).toBeUndefined();
  });
});

describe("stores per workspace", () => {
  it("each workspace has its own state, user and Wispr Flow connection; the key is shared", async () => {
    const { getFileStore: getStore, me } = await import("./app");
    getStore().addUser({ email: "you@this-mac", name: "Home me" });
    await getStore().saveConnection({ userId: (await me())!.id, provider: "wispr_flow", accessToken: "a", refreshToken: "r", expiresAt: "2099-01-01T00:00:00.000Z", lastSeenAt: null, status: "active" });
    const ws = addWorkspace("Side", tmp());
    setActiveWorkspace(ws.id);
    expect(await me()).toBeNull();
    getStore().addUser({ email: "you@this-mac", name: "Side me" });
    expect((await me())!.name).toBe("Side me");
    expect(await getStore().getConnection((await me())!.id)).toBeNull();
    expect(existsSync(join(ws.path, ".daily-brief", "state.json"))).toBe(true);
    expect(existsSync(join(ws.path, ".daily-brief", "key"))).toBe(false);
    setActiveWorkspace(HOME_ID);
    expect((await me())!.name).toBe("Home me");
  });

  it("the scheduler visits every workspace, pinned to each, past a failing one", async () => {
    const { forEachWorkspace } = await import("./scheduler");
    const a = addWorkspace("A", tmp());
    const b = addWorkspace("B", tmp());
    const seen: string[] = [];
    await forEachWorkspace(async (ws) => {
      seen.push(notesDir());
      if (ws.id === a.id) throw new Error("boom");
    });
    expect(seen).toEqual([home, a.path, b.path]);
  });

  it("queued jobs run in the workspace they were queued in", async () => {
    const { runExclusive } = await import("./scheduler");
    const ws = addWorkspace("Side", tmp());
    setActiveWorkspace(ws.id);
    const gate = new Promise((r) => setTimeout(r, 10));
    const first = runExclusive(() => gate);
    const queued = runExclusive(async () => notesDir());
    setActiveWorkspace(HOME_ID);
    await first;
    expect(await queued).toBe(ws.path);
  });
});
