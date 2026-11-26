// What you told the app about found threads, in <data>/threads.json: the ones that are not one
// thread, and each thread's AI-written "Where it stands" with the fingerprint it was written for.
// Nothing here files an item.
import { join } from "node:path";
import { readJson, writeJson } from "./json-file";
import { dataDir } from "./paths";

export interface Stands { sig: string; text: string; at: string; model: string }
export interface ThreadsFile { version: 1; dismissed: string[]; stands: Record<string, Stands> }
const empty = (): ThreadsFile => ({ version: 1, dismissed: [], stands: {} });
const file = (dir = dataDir()) => join(dir, "threads.json");

export function readThreads(dir = dataDir()): ThreadsFile {
  const f = readJson<ThreadsFile>(file(dir), empty());
  return { version: 1, dismissed: Array.isArray(f.dismissed) ? f.dismissed.filter((x) => typeof x === "string") : [], stands: f.stands && typeof f.stands === "object" ? f.stands : {} };
}

function save(change: (f: ThreadsFile) => void, dir = dataDir()): ThreadsFile {
  const f = readThreads(dir);
  change(f);
  writeJson(file(dir), f);
  return f;
}

export function setDismissed(id: string, on: boolean, dir = dataDir()): void {
  save((f) => { f.dismissed = on ? [...new Set([...f.dismissed, id])] : f.dismissed.filter((x) => x !== id); }, dir);
}

export function saveStands(id: string, s: Stands, dir = dataDir()): void {
  save((f) => { f.stands[id] = s; }, dir);
}
