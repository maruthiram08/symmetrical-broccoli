// Recorders: where meetings come from. Wispr Flow is read over MCP (src/server/wispr); the
// others are local files read on this Mac. Each meeting carries its `provider`, and its
// transcript is fetched by provider at read time (transcriptFor), never stored.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { providerOf, type Meeting, type MeetingProvider, type SourceSettings, type SourceToggle, type User } from "@/lib/types";
import type { Store } from "@/server/store";
import { dedupeNewMeeting } from "./dedupe";
import { defaultInboxDir, defaultZoomDir, scanInbox, scanZoom, type FoundMeeting } from "./files";
import { findGranolaCache, granolaTranscript, readGranolaCache } from "./granola";
import { parseTranscriptBytes } from "./parse";

export const PROVIDER_LABEL: Record<MeetingProvider, string> = {
  wispr_flow: "Wispr Flow", granola: "Granola", zoom: "Zoom", google_meet: "Google Meet", file: "Transcript file", phone: "Phone call",
};

export type SourceKey = keyof SourceSettings;
export const SOURCE_KEYS: SourceKey[] = ["granola", "zoom", "files", "phone"];

/** A Granola meeting still being recorded (a segment in the last 10 minutes) waits. */
export const GRANOLA_SETTLE_MS = 10 * 60_000;
/** Turning a source on reads this far back, not its whole history. */
export const SOURCE_BACKFILL_DAYS = 7;

export class TranscriptMissingError extends Error {
  constructor(why: string) { super(why); this.name = "TranscriptMissingError"; }
}

export function sourceOn(user: Pick<User, "sources">, key: SourceKey): SourceToggle | null {
  const t = user.sources?.[key];
  return t?.enabled ? t : null;
}

export function zoomDir(user: Pick<User, "sources">): string {
  return user.sources?.zoom?.path || defaultZoomDir();
}
/** Google Meet files and phone calls share one inbox folder; its path is kept on `files`. */
export function inboxDir(user: Pick<User, "sources">): string {
  return user.sources?.files?.path || user.sources?.phone?.path || defaultInboxDir();
}

/**
 * The transcript of a meeting from a local recorder, read now from its source. Throws
 * TranscriptMissingError when the file or cache entry is gone. Never store or log the result.
 */
export async function localTranscript(m: Meeting, user: Pick<User, "name" | "timeZone" | "sources">): Promise<string> {
  const provider = providerOf(m);
  if (provider === "wispr_flow") throw new Error("wispr_flow meetings are read through the Wispr Flow client");
  if (provider === "granola") {
    const file = findGranolaCache(user.sources?.granola?.path);
    if (!file) throw new TranscriptMissingError("granola cache not found");
    const id = m.providerMeetingId.replace(/^granola:/, "");
    const doc = readGranolaCache(file).find((d) => d.id === id);
    if (!doc) throw new TranscriptMissingError("granola meeting not in cache");
    return granolaTranscript(doc, user.name);
  }
  if (!m.sourcePath) throw new TranscriptMissingError("no source file");
  let buf: Buffer;
  try {
    buf = readFileSync(m.sourcePath);
  } catch {
    throw new TranscriptMissingError("source file gone");
  }
  return asYou(parseTranscriptBytes(basename(m.sourcePath), buf, user.timeZone).text, user.name);
}

/** Call exports label the user "Me" or "You": use their name, so the reading knows whose promise it is. */
export function asYou(text: string, name: string): string {
  return name ? text.replace(/^(me|myself|you|i)(?=: )/gim, name) : text;
}

/** Meetings the user's turned-on local sources hold right now, with the kind each counts as. */
export function scanSources(user: User, now: Date): FoundMeeting[] {
  const out: FoundMeeting[] = [];
  const nowMs = now.getTime();
  const after = (t: SourceToggle, iso: string) => !t.since || iso >= t.since;
  const granola = sourceOn(user, "granola");
  if (granola) {
    const file = findGranolaCache(granola.path);
    if (file) {
      try {
        for (const d of readGranolaCache(file)) {
          if (!after(granola, d.startedAt)) continue;
          if (d.lastAt && nowMs - Date.parse(d.lastAt) < GRANOLA_SETTLE_MS) continue;
          out.push({ provider: "granola", providerMeetingId: `granola:${d.id}`, title: d.title, startedAt: d.startedAt, participants: d.participants, sourcePath: null });
        }
      } catch (e) {
        console.error(`[granola] ${e instanceof Error ? e.name : "Error"}`);
      }
    }
  }
  const zoom = sourceOn(user, "zoom");
  if (zoom) for (const f of scanZoom(zoomDir(user), user.timeZone, nowMs)) if (after(zoom, f.startedAt)) out.push(f);
  const files = sourceOn(user, "files"), phone = sourceOn(user, "phone");
  if (files || phone) {
    for (const f of scanInbox(inboxDir(user), user.timeZone, nowMs)) {
      if (f.kind === "phone" ? phone : files) {
        out.push({ provider: f.provider, providerMeetingId: f.providerMeetingId, title: f.title, startedAt: f.startedAt, participants: f.participants, sourcePath: f.sourcePath });
      }
    }
  }
  return out;
}

export interface ImportResult { found: number; created: number; duplicates: number }

/**
 * Queue new meetings from the user's local sources. Idempotent: a meeting already queued (same
 * provider and id) is skipped. A new one that another recorder already brought in is closed as a
 * duplicate without a read. Never throws.
 */
export async function importSources(store: Store, user: User, now: Date): Promise<ImportResult> {
  const res: ImportResult = { found: 0, created: 0, duplicates: 0 };
  if (!user.sources || !SOURCE_KEYS.some((k) => user.sources?.[k]?.enabled)) return res;
  let found: FoundMeeting[];
  try {
    found = scanSources(user, now);
  } catch (e) {
    console.error(`[sources] ${e instanceof Error ? e.name : "Error"}`);
    return res;
  }
  res.found = found.length;
  for (const f of found.sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
    try {
      const r = await store.upsertMeeting({
        userId: user.id,
        provider: f.provider,
        providerMeetingId: f.providerMeetingId,
        title: f.title,
        startedAt: f.startedAt,
        participants: f.participants,
        ...(f.sourcePath ? { sourcePath: f.sourcePath } : {}),
      });
      if (!r.created) continue;
      res.created++;
      if (await dedupeNewMeeting(store, r.meeting, now.toISOString())) res.duplicates++;
    } catch (e) {
      console.error(`[sources] couldn't queue a ${f.provider} meeting: ${e instanceof Error ? e.name : "Error"}`);
    }
  }
  return res;
}

/** Every user's local sources (the local app has one user). Never throws. */
export async function importAllSources(store: Store, now: Date): Promise<ImportResult> {
  const total: ImportResult = { found: 0, created: 0, duplicates: 0 };
  let users: User[] = [];
  try { users = await store.listUsers(); } catch { return total; }
  for (const u of users) {
    const r = await importSources(store, u, now);
    total.found += r.found; total.created += r.created; total.duplicates += r.duplicates;
  }
  return total;
}
