// Workspaces: each one is a notes folder with its own .daily-brief/ (state, Wispr Flow connection,
// templates, sync settings). The list lives in the home folder's .daily-brief/workspaces.json, so
// the home folder (DAILY_BRIEF_DIR, else ~/Daily Brief) is always the first workspace and an app
// that never adds another one behaves exactly as before.

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

export const HOME_ID = "home";
/** Carries the workspace across the Wispr Flow sign-in redirect. */
export const WORKSPACE_COOKIE = "db_ws";

export interface FolderSyncSettings {
  /** The extra folder (an iCloud Drive folder, an Obsidian vault). Files go in its daily-brief/ subfolder. */
  folder: string;
  enabled: boolean;
}

export interface GitSettings {
  /** Commit after each brief when the notes folder is a git repo. On unless turned off. */
  commit: boolean;
  /** Push after committing. Off unless turned on. Uses your own git credentials. */
  push: boolean;
  /** A remote's name, like "origin". Never a URL, so no token can end up here. */
  remote: string;
}

export interface Workspace {
  id: string;
  name: string;
  /** Absolute path of the notes folder. */
  path: string;
  sync?: FolderSyncSettings | null;
  git?: Partial<GitSettings>;
  /** [[Nitin]]-style links in generated Markdown. On unless turned off. */
  links?: boolean;
}

interface Registry {
  version: 1;
  active: string;
  workspaces: Workspace[];
}

export const DEFAULT_GIT: GitSettings = { commit: true, push: false, remote: "origin" };

/** The home notes folder: DAILY_BRIEF_DIR, else ~/Daily Brief. It is always a workspace. */
export function homeDir(): string {
  return process.env.DAILY_BRIEF_DIR ?? join(homedir(), "Daily Brief");
}
export function homeDataDir(): string {
  return join(homeDir(), ".daily-brief");
}
export function registryPath(): string {
  return join(homeDataDir(), "workspaces.json");
}

const home = (): Workspace => ({ id: HOME_ID, name: "Daily Brief", path: homeDir() });

let cache: { path: string; mtimeMs: number; size: number; reg: Registry } | null = null;

function readRegistry(): Registry {
  const p = registryPath();
  let st: { mtimeMs: number; size: number } | null = null;
  try { st = statSync(p); } catch { st = null; }
  if (!st) return { version: 1, active: HOME_ID, workspaces: [home()] };
  if (cache && cache.path === p && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.reg;
  let reg: Registry;
  try {
    const o = JSON.parse(readFileSync(p, "utf8")) as Partial<Registry>;
    reg = { version: 1, active: typeof o.active === "string" ? o.active : HOME_ID, workspaces: Array.isArray(o.workspaces) ? o.workspaces.filter(valid) : [] };
  } catch {
    reg = { version: 1, active: HOME_ID, workspaces: [] };
  }
  // The home workspace always follows DAILY_BRIEF_DIR, whatever the file says about its path.
  const h = reg.workspaces.find((w) => w.id === HOME_ID);
  if (h) h.path = homeDir();
  else reg.workspaces.unshift(home());
  if (!reg.workspaces.some((w) => w.id === reg.active)) reg.active = HOME_ID;
  cache = { path: p, mtimeMs: st.mtimeMs, size: st.size, reg };
  return reg;
}

function valid(w: unknown): w is Workspace {
  const o = w as Workspace | null;
  return !!o && typeof o.id === "string" && typeof o.name === "string" && typeof o.path === "string" && isAbsolute(o.path);
}

function writeRegistry(reg: Registry): void {
  const p = registryPath();
  mkdirSync(homeDataDir(), { recursive: true, mode: 0o700 });
  const tmp = `${p}.${process.pid}.tmp`;
  const out: Registry = { ...reg, workspaces: reg.workspaces.map((w) => (w.id === HOME_ID ? { ...w, path: homeDir() } : w)) };
  writeFileSync(tmp, JSON.stringify(out, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, p);
  cache = null;
}

export function listWorkspaces(): Workspace[] {
  return readRegistry().workspaces.map((w) => ({ ...w }));
}

export function getWorkspace(id: string): Workspace | null {
  return listWorkspaces().find((w) => w.id === id) ?? null;
}

/** The workspace you picked last (remembered in workspaces.json). */
export function activeWorkspace(): Workspace {
  const reg = readRegistry();
  return { ...(reg.workspaces.find((w) => w.id === reg.active) ?? reg.workspaces[0]) };
}

const als = new AsyncLocalStorage<Workspace>();

/** Run `fn` against one workspace whatever is active (the scheduler works through each in turn). */
export function withWorkspace<T>(ws: Workspace, fn: () => T): T {
  return als.run(ws, fn);
}

/** The workspace this code runs for: the one set by withWorkspace, else the active one. */
export function currentWorkspace(): Workspace {
  const pinned = als.getStore();
  if (pinned) return getWorkspace(pinned.id) ?? pinned;
  return activeWorkspace();
}

export function setActiveWorkspace(id: string): Workspace {
  const reg = readRegistry();
  const ws = reg.workspaces.find((w) => w.id === id);
  if (!ws) throw new Error("No such workspace.");
  writeRegistry({ ...reg, active: id });
  return { ...ws };
}

/** Expand ~ and make the path absolute. */
export function normalizeFolder(input: string): string {
  const t = input.trim();
  const expanded = t === "~" ? homedir() : t.startsWith("~/") ? join(homedir(), t.slice(2)) : t;
  return resolve(expanded);
}

/** True when `child` is `parent` or inside it. */
export function within(parent: string, child: string): boolean {
  const r = relative(resolve(parent), resolve(child));
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
}

/** Add a workspace for a folder (created when missing). Its data starts empty. */
export function addWorkspace(name: string, folder: string): Workspace {
  const clean = name.trim().slice(0, 60);
  if (!clean) throw new Error("Give the workspace a name.");
  const path = normalizeFolder(folder);
  const reg = readRegistry();
  for (const w of reg.workspaces) {
    if (resolve(w.path) === path) throw new Error(`That folder is already the workspace “${w.name}”.`);
    if (within(join(w.path, ".daily-brief"), path)) throw new Error("Pick a folder outside the app's data folder.");
  }
  if (existsSync(path) && !statSync(path).isDirectory()) throw new Error("That path is a file, not a folder.");
  mkdirSync(path, { recursive: true });
  const ws: Workspace = { id: randomUUID().slice(0, 8), name: clean, path };
  writeRegistry({ ...reg, workspaces: [...reg.workspaces, ws] });
  return ws;
}

export function updateWorkspace(id: string, patch: Partial<Pick<Workspace, "name" | "sync" | "git" | "links">>): Workspace {
  const reg = readRegistry();
  const i = reg.workspaces.findIndex((w) => w.id === id);
  if (i < 0) throw new Error("No such workspace.");
  const next = { ...reg.workspaces[i], ...patch };
  if (patch.name !== undefined) {
    next.name = patch.name.trim().slice(0, 60);
    if (!next.name) throw new Error("Give the workspace a name.");
  }
  if (patch.git) next.git = { ...reg.workspaces[i].git, ...patch.git };
  const workspaces = [...reg.workspaces];
  workspaces[i] = next;
  writeRegistry({ ...reg, workspaces });
  return { ...next };
}

/** Take a workspace off the list. Its folder and files stay where they are. The home one can't go. */
export function removeWorkspace(id: string): void {
  if (id === HOME_ID) throw new Error("The home workspace can't be removed.");
  const reg = readRegistry();
  if (!reg.workspaces.some((w) => w.id === id)) return;
  writeRegistry({ ...reg, active: reg.active === id ? HOME_ID : reg.active, workspaces: reg.workspaces.filter((w) => w.id !== id) });
}

export function gitSettings(ws: Workspace): GitSettings {
  return { ...DEFAULT_GIT, ...(ws.git ?? {}) };
}
export const linksOn = (ws: Workspace) => ws.links !== false;
