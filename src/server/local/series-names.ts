// What you told the app about recurring series, in <data>/series.json: a name you gave a series
// (the guessed "4:30 PM meeting" becomes "Product sync") and the ones that are not a series.
// Keys are the series keys the Recurring page uses ("slot:…" or "id:…").
import { join } from "node:path";
import { readJson, writeJson } from "./json-file";
import { dataDir } from "./paths";

export interface SeriesFile { version: 1; names: Record<string, string>; hidden: string[] }
const empty = (): SeriesFile => ({ version: 1, names: {}, hidden: [] });
const file = (dir = dataDir()) => join(dir, "series.json");
export const MAX_SERIES_NAME = 80;

export function readSeriesFile(dir = dataDir()): SeriesFile {
  const f = readJson<SeriesFile>(file(dir), empty());
  const names: Record<string, string> = {};
  if (f.names && typeof f.names === "object") for (const [k, v] of Object.entries(f.names)) if (typeof v === "string" && v.trim()) names[k] = v.trim().slice(0, MAX_SERIES_NAME);
  return { version: 1, names, hidden: Array.isArray(f.hidden) ? f.hidden.filter((x) => typeof x === "string") : [] };
}

function save(change: (f: SeriesFile) => void, dir = dataDir()): SeriesFile {
  const f = readSeriesFile(dir);
  change(f);
  writeJson(file(dir), f);
  return f;
}

/** An empty name goes back to the guessed (or calendar) title. */
export function renameSeries(key: string, name: string, dir = dataDir()): SeriesFile {
  const n = name.replace(/\s+/g, " ").trim().slice(0, MAX_SERIES_NAME);
  return save((f) => { if (n) f.names[key] = n; else delete f.names[key]; }, dir);
}

export function setSeriesHidden(key: string, on: boolean, dir = dataDir()): SeriesFile {
  return save((f) => { f.hidden = on ? [...new Set([...f.hidden, key])] : f.hidden.filter((x) => x !== key); }, dir);
}
