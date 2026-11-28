// Turning sources on and off, and transcripts uploaded from Settings. Kept apart from the server
// actions so the rules are tested without Next.
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join } from "node:path";
import type { SourceSettings } from "@/lib/types";
import { MAX_FILE_BYTES, SETTLE_MS } from "./files";
import { isTranscriptFile } from "./parse";
import { SOURCE_BACKFILL_DAYS, SOURCE_KEYS, type SourceKey } from ".";

export function isSourceKey(k: unknown): k is SourceKey {
  return typeof k === "string" && (SOURCE_KEYS as string[]).includes(k);
}

/** "~/Documents/Zoom" -> absolute. Null for an empty or relative path (or one with a NUL). */
export function cleanPath(raw: string): string | null {
  const p = raw.trim();
  if (!p || p.length > 500 || p.includes("\0")) return null;
  const full = p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
  return isAbsolute(full) ? full : null;
}

/**
 * New source settings after a switch or a folder change. Turning Granola or Zoom on sets `since`
 * to 7 days back, so a long history isn't read (and paid for) at once; turning it off and on again
 * keeps the first `since`. The inbox (files, phone) reads whatever you drop in, so it has none.
 * `path` undefined keeps the current folder; "" goes back to the default.
 */
export function changeSource(sources: SourceSettings | undefined, key: SourceKey, change: { enabled?: boolean; path?: string | null }, now: Date): SourceSettings {
  const next: SourceSettings = { ...(sources ?? {}) };
  const cur = { enabled: false, ...(next[key] ?? {}) };
  if (change.enabled !== undefined) {
    cur.enabled = change.enabled;
    if (change.enabled && !cur.since && (key === "granola" || key === "zoom")) {
      cur.since = new Date(now.getTime() - SOURCE_BACKFILL_DAYS * 86_400_000).toISOString();
    }
  }
  if (change.path !== undefined) cur.path = change.path || null;
  next[key] = cur;
  // Files and phone calls share one inbox folder.
  if ((key === "files" || key === "phone") && change.path !== undefined) {
    const other = key === "files" ? "phone" : "files";
    next[other] = { enabled: false, ...(next[other] ?? {}), path: change.path || null };
  }
  return next;
}

export class UploadError extends Error {
  constructor(public reason: "type" | "size" | "empty") { super(reason); this.name = "UploadError"; }
}

/**
 * Save an uploaded transcript into the inbox, where the next scan picks it up. Never overwrites:
 * a name already taken gets " (2)", " (3)"... Returns the saved path.
 */
export function saveUpload(dir: string, name: string, data: Buffer, lastModifiedMs?: number, nowMs = Date.now()): string {
  const safe = basename(name).replace(/[\\/:*?"<>|\0]+/g, " ").replace(/^\.+/, "").trim().slice(0, 120) || "transcript.txt";
  if (!isTranscriptFile(safe)) throw new UploadError("type");
  if (!data.length) throw new UploadError("empty");
  if (data.length > MAX_FILE_BYTES) throw new UploadError("size");
  mkdirSync(dir, { recursive: true });
  const ext = extname(safe), stem = safe.slice(0, safe.length - ext.length);
  let p = join(dir, safe);
  for (let n = 2; existsSync(p); n++) p = join(dir, `${stem} (${n})${ext}`);
  writeFileSync(p, data, { mode: 0o600, flag: "wx" });
  // Keep the file's own time (the browser sends it): a transcript without a time in it is dated by
  // it. An upload is complete when it gets here, so it never needs to wait to settle.
  const settled = nowMs - SETTLE_MS - 1000;
  const t = lastModifiedMs && Number.isFinite(lastModifiedMs) && lastModifiedMs < settled ? lastModifiedMs : settled;
  utimesSync(p, new Date(t), new Date(t));
  return p;
}
