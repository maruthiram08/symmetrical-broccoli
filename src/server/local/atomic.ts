import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Write a file all at once: a temp file next to it, then a rename, so a reader (iCloud, Obsidian,
 * git) never sees half a file. Returns false (and writes nothing) when the content is already there.
 */
export function writeAtomic(path: string, content: string, mode?: number): boolean {
  if (existsSync(path)) {
    try { if (readFileSync(path, "utf8") === content) return false; } catch { /* unreadable: write it again */ }
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    writeFileSync(tmp, content, mode === undefined ? undefined : { mode });
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
  return true;
}
