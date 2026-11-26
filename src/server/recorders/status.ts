// What Settings shows for each local source: where it looks, whether that exists, what it found.
import { statSync } from "node:fs";
import { providerOf, type Meeting, type MeetingProvider, type User } from "@/lib/types";
import { scanInbox, scanZoom } from "./files";
import { granolaDir, granolaStatus, readGranolaCache } from "./granola";
import { inboxDir, SOURCE_BACKFILL_DAYS, SOURCE_KEYS, zoomDir, type SourceKey } from ".";

export interface SourceStatus {
  key: SourceKey;
  enabled: boolean;
  /** Folder or file it reads. */
  path: string;
  /** The folder or cache file is there. */
  present: boolean;
  /** Meetings found there right now (null when it couldn't look). */
  found: number | null;
  /** Of those, how many started since the source was turned on (what gets read). */
  sinceCount: number | null;
  since: string | null;
  /** Meetings already brought in from it, and how many were copies of another recorder's. */
  imported: number;
  duplicates: number;
  error: string | null;
}

const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };

const PROVIDERS: Record<SourceKey, MeetingProvider[]> = {
  granola: ["granola"], zoom: ["zoom"], files: ["google_meet", "file"], phone: ["phone"],
};

/** Status of every local source. Looks at disk, so it is only called by the Settings page. Never throws. */
export function sourceStatuses(user: User, meetings: Meeting[], now: Date): SourceStatus[] {
  const nowMs = now.getTime();
  const inbox = inboxDir(user);
  let inboxFound: ReturnType<typeof scanInbox> | null = null;
  const inboxScan = () => (inboxFound ??= isDir(inbox) ? scanInbox(inbox, user.timeZone, nowMs) : []);
  return SOURCE_KEYS.map((key) => {
    const t = user.sources?.[key];
    // Off: show what turning it on would read (the last 7 days); files dropped in the inbox are always read.
    const since = t?.since ?? (!t?.enabled && (key === "granola" || key === "zoom") ? new Date(nowMs - SOURCE_BACKFILL_DAYS * 86_400_000).toISOString() : null);
    const mine = meetings.filter((m) => PROVIDERS[key].includes(providerOf(m)));
    const base = { key, enabled: t?.enabled === true, since, imported: mine.filter((m) => !m.duplicateOf).length, duplicates: mine.filter((m) => m.duplicateOf).length, error: null as string | null };
    const count = (starts: string[]) => ({ found: starts.length, sinceCount: since ? starts.filter((s) => s >= since).length : starts.length });
    try {
      if (key === "granola") {
        const g = granolaStatus(t?.path);
        const starts = g.file && g.found !== null ? readGranolaCache(g.file).map((d) => d.startedAt) : null;
        return { ...base, path: g.file ?? (t?.path || granolaDir()), present: !!g.file, ...(starts ? count(starts) : { found: null, sinceCount: null }), error: g.error };
      }
      if (key === "zoom") {
        const dir = zoomDir(user);
        if (!isDir(dir)) return { ...base, path: dir, present: false, found: null, sinceCount: null };
        return { ...base, path: dir, present: true, ...count(scanZoom(dir, user.timeZone, nowMs).map((f) => f.startedAt)) };
      }
      const present = isDir(inbox);
      const list = inboxScan().filter((f) => (key === "phone" ? f.kind === "phone" : f.kind !== "phone"));
      return { ...base, path: inbox, present, found: present ? list.length : null, sinceCount: null };
    } catch {
      return { ...base, path: "", present: false, found: null, sinceCount: null, error: "couldn't look" };
    }
  });
}
