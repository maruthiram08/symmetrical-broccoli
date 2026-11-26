// What the last folder sync, git commit and push did, per workspace, for Settings.
// Kept in <notes>/.daily-brief/sync.json. Never holds file contents, tokens or remote URLs.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./atomic";
import type { Workspace } from "./workspaces";

export interface SyncResult { at: string; ok: boolean; detail: string }

export interface SyncStatus {
  folder?: SyncResult;
  git?: SyncResult;
  push?: SyncResult;
  /** A template that couldn't be used (the default was used instead). */
  template?: SyncResult;
}

const file = (ws: Pick<Workspace, "path">) => join(ws.path, ".daily-brief", "sync.json");

export function readSyncStatus(ws: Pick<Workspace, "path">): SyncStatus {
  try {
    return JSON.parse(readFileSync(file(ws), "utf8")) as SyncStatus;
  } catch {
    return {};
  }
}

export function recordSync(ws: Pick<Workspace, "path">, patch: Partial<Record<keyof SyncStatus, SyncResult | undefined>>): void {
  try {
    const next = { ...readSyncStatus(ws), ...patch };
    for (const k of Object.keys(next) as Array<keyof SyncStatus>) if (next[k] === undefined) delete next[k];
    writeAtomic(file(ws), JSON.stringify(next, null, 2) + "\n", 0o600);
  } catch (e) {
    console.error(`[sync] couldn't record status: ${e instanceof Error ? e.name : "Error"}`);
  }
}
