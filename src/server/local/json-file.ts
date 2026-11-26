import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Reads a small JSON file, or returns `fallback` when it is missing or damaged. Never throws. */
export function readJson<T>(path: string, fallback: T): T {
  // A fresh copy each time: callers change what they read, and must never change the fallback.
  try {
    if (!existsSync(path)) return structuredClone(fallback);
    return { ...structuredClone(fallback), ...(JSON.parse(readFileSync(path, "utf8")) as T) };
  } catch {
    return structuredClone(fallback);
  }
}

/** Writes JSON readable only by you (0600), through a temp file and rename so a crash never leaves half a file. */
export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}
