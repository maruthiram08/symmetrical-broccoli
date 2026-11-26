// Transcript files on disk: Zoom's local recordings folder and the Daily Brief inbox folder
// (Google Meet downloads, phone-call exports, any transcript you drop in). Scans are cheap: a file
// whose size and mtime haven't changed since the last scan is not read again.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import type { MeetingProvider } from "@/lib/types";
import { notesDir } from "@/server/local/paths";
import { findDate, PHONE_RE, titleFromName } from "./parse/common";
import { isTranscriptFile, parseTranscriptBytes, type ParsedTranscript } from "./parse";
import { parseZoomCaptions } from "./parse/formats";

/** A meeting found on disk, ready to be queued. Holds no transcript text. */
export interface FoundMeeting {
  provider: MeetingProvider;
  providerMeetingId: string;
  title: string;
  startedAt: string;
  participants: string[];
  /** The transcript file; null for Granola (read from its cache by id). */
  sourcePath: string | null;
}

/** Files bigger than this aren't transcripts (or are too big to read in one go). */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** A file changed this recently may still be being written: wait for the next scan. */
export const SETTLE_MS = 60_000;
const MAX_FILES = 2000;

export function defaultZoomDir(): string {
  return process.env.ZOOM_DIR ?? join(homedir(), "Documents", "Zoom");
}
/** The inbox: drop any transcript file here. ~/Daily Brief/inbox by default. */
export function defaultInboxDir(): string {
  return join(notesDir(), "inbox");
}

/** Every file under `root`, at most `depth` folders down, skipping hidden ones. Never throws. */
export function listFiles(root: string, depth: number): Array<{ path: string; size: number; mtimeMs: number }> {
  const out: Array<{ path: string; size: number; mtimeMs: number }> = [];
  const walk = (dir: string, d: number) => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names.sort()) {
      if (out.length >= MAX_FILES || n.startsWith(".")) continue;
      const p = join(dir, n);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { if (d > 0) walk(p, d - 1); }
      else if (st.isFile()) out.push({ path: p, size: st.size, mtimeMs: st.mtimeMs });
    }
  };
  walk(root, depth);
  return out;
}

/** Last parse of each file, by path, so an unchanged file is never read twice. */
const scanned = new Map<string, { sig: string; found: FoundMeeting | null; kind: InboxKind | null }>();
export function clearScanCache(): void { scanned.clear(); }

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex").slice(0, 24);

/** When the file says nothing about time: it was saved when the meeting ended. */
function fromMtime(mtimeMs: number, p: ParsedTranscript): string {
  return new Date(mtimeMs - (p.durationSec ?? 0) * 1000).toISOString();
}

// ---------- Zoom ----------

/** Zoom files that hold a transcript (not chat logs, not media). */
function isZoomTranscript(name: string): boolean {
  const lower = name.toLowerCase();
  if (!isTranscriptFile(name) || /chat/.test(lower)) return false;
  const ext = extname(lower);
  return ext === ".vtt" || ext === ".srt" || (ext === ".txt" && /(caption|transcript)/.test(lower));
}

/**
 * Zoom recordings: each meeting is a folder "2026-11-24 10.00.00 Pricing review" (local time) with
 * a transcript .vtt (cloud downloads: "GMT20261124-043000_Recording.transcript.vtt", UTC) and/or
 * saved closed captions (meeting_saved_closed_caption.txt). One meeting per folder; a .vtt is
 * preferred over captions. Loose transcript files in the root count as one meeting each.
 */
export function scanZoom(root: string, timeZone: string, nowMs: number): FoundMeeting[] {
  const files = listFiles(root, 2).filter((f) => isZoomTranscript(basename(f.path)) && f.size <= MAX_FILE_BYTES && nowMs - f.mtimeMs >= SETTLE_MS);
  const groups = new Map<string, typeof files>();
  for (const f of files) {
    const key = dirname(f.path) === root ? f.path : dirname(f.path);
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  const out: FoundMeeting[] = [];
  for (const [key, list] of groups) {
    const rank = (p: string) => (extname(p).toLowerCase() === ".vtt" ? 0 : extname(p).toLowerCase() === ".srt" ? 1 : 2);
    const f = [...list].sort((a, b) => rank(a.path) - rank(b.path))[0];
    const sig = `zoom:${timeZone}:${f.size}:${f.mtimeMs}`;
    const hit = scanned.get(f.path);
    if (hit && hit.sig === sig) { if (hit.found) out.push(hit.found); continue; }
    let found: FoundMeeting | null = null;
    try {
      const buf = readFileSync(f.path);
      const parsed = parseTranscriptBytes(basename(f.path), buf, timeZone);
      if (parsed.text.trim()) {
        const folder = key === f.path ? basename(f.path) : basename(key);
        const named = findDate(folder, timeZone) ?? findDate(basename(f.path), timeZone);
        let startedAt = named?.iso ?? null;
        // Captions give a local time of day; the folder gives the day.
        if (named && !named.hasTime && extname(f.path).toLowerCase() === ".txt") {
          const clock = parseZoomCaptions(buf.toString("utf8")).firstClock;
          const day = new Date(named.iso);
          if (clock) startedAt = findDate(`${day.toISOString().slice(0, 10)} ${clock}`, timeZone)?.iso ?? startedAt;
        }
        found = {
          provider: "zoom",
          providerMeetingId: `zoom:${sha(relative(root, key).split(sep).join("/"))}`,
          title: titleFromName(folder) || parsed.title || "Zoom meeting",
          startedAt: startedAt ?? fromMtime(f.mtimeMs, parsed),
          participants: parsed.speakers,
          sourcePath: f.path,
        };
      }
    } catch {
      found = null; // unreadable: skipped, and tried again when it changes
    }
    scanned.set(f.path, { sig, found, kind: null });
    if (found) out.push(found);
  }
  return out;
}

// ---------- Inbox (Google Meet, phone calls, any transcript file) ----------

export type InboxKind = "google_meet" | "phone" | "file";

/** What kind of transcript an inbox file is, from its folder, name and contents. */
export function classifyInbox(relPath: string, parsed: ParsedTranscript): InboxKind {
  const parts = relPath.split(/[\\/]/);
  const folder = parts.length > 1 ? parts[0].toLowerCase() : "";
  const name = parts[parts.length - 1];
  if (/^(phone|calls?|phone calls?)$/.test(folder)) return "phone";
  if (/^(meet|google meet|google-meet)$/.test(folder)) return "google_meet";
  if (PHONE_RE.test(name.replace(/[_-]+/g, " ")) || /^(call|phone)\b/i.test(name) || parsed.looksLikePhone) return "phone";
  if (parsed.looksLikeMeet || extname(name).toLowerCase() === ".docx" || /\(\d{4}-\d{2}-\d{2}[^)]*\)\s*-\s*transcript/i.test(name)) return "google_meet";
  return "file";
}

/**
 * Every transcript in the inbox folder (and one level of subfolders, such as inbox/phone/).
 * A file is identified by its contents, so the same file dropped twice is one meeting.
 * Title: from the contents' title line or heading, else the file name. Time: from the contents,
 * else the file name, else the file's mtime less the recording's length.
 */
export function scanInbox(root: string, timeZone: string, nowMs: number): Array<FoundMeeting & { kind: InboxKind }> {
  const out: Array<FoundMeeting & { kind: InboxKind }> = [];
  for (const f of listFiles(root, 1)) {
    const name = basename(f.path);
    if (!isTranscriptFile(name) || f.size > MAX_FILE_BYTES || f.size === 0 || nowMs - f.mtimeMs < SETTLE_MS) continue;
    const sig = `inbox:${timeZone}:${f.size}:${f.mtimeMs}`;
    const hit = scanned.get(f.path);
    if (hit && hit.sig === sig) { if (hit.found && hit.kind) out.push({ ...hit.found, kind: hit.kind }); continue; }
    let found: FoundMeeting | null = null;
    let kind: InboxKind | null = null;
    try {
      const buf = readFileSync(f.path);
      const parsed = parseTranscriptBytes(name, buf, timeZone);
      if (parsed.text.trim()) {
        const rel = relative(root, f.path);
        kind = classifyInbox(rel, parsed);
        const provider: MeetingProvider = kind;
        const fromName = titleFromName(name);
        const title = parsed.title || fromName || (kind === "phone" ? "Phone call" : "Meeting");
        found = {
          provider,
          providerMeetingId: `file:${sha(buf)}`,
          title,
          startedAt: parsed.startedAt ?? findDate(name, timeZone)?.iso ?? fromMtime(f.mtimeMs, parsed),
          participants: parsed.speakers,
          sourcePath: f.path,
        };
      }
    } catch {
      found = null;
    }
    scanned.set(f.path, { sig, found, kind });
    if (found && kind) out.push({ ...found, kind });
  }
  return out;
}
