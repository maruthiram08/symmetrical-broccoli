// One meeting recorded by two tools (Wispr Flow and Granola, or Zoom captions and a Meet doc)
// must be read once, or every promise in it shows up twice.
import { providerOf, type Meeting } from "@/lib/types";
import type { Store } from "@/server/store";

/** Two recordings of one meeting start within this much of each other. */
export const DEDUPE_WINDOW_MS = 10 * 60_000;
/** Titles at least this alike (word overlap) name the same meeting. */
export const TITLE_SIMILARITY = 0.5;
/** With a generic title ("Zoom meeting", "Call"), starts this close count as the same meeting. */
const GENERIC_WINDOW_MS = 3 * 60_000;

/** Words that say nothing about which meeting it was. */
const FILLER = new Set([
  "meeting", "meet", "call", "zoom", "google", "granola", "transcript", "recording", "notes", "with", "and", "the", "for",
  "personal", "room", "phone", "sync", "chat", "a", "an", "of", "s", "my", "new", "untitled", "gmt",
]);

export function titleWords(title: string): Set<string> {
  // Zoom's default "Asha Rao's Zoom Meeting" names the host, not the meeting.
  if (/['’]s\s+(zoom meeting|personal meeting room|meeting)\s*$/i.test(title.trim())) return new Set();
  return new Set(
    title.toLowerCase().replace(/'s\b/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").split(/\s+/)
      .filter((w) => w.length > 1 && !FILLER.has(w) && !/^\d+$/.test(w)),
  );
}

/** 0..1: word overlap of two titles, ignoring filler words; 1 when one title's words all appear in the other. */
export function titleSimilarity(a: string, b: string): number {
  const A = titleWords(a), B = titleWords(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  if (n === Math.min(A.size, B.size)) return 1;
  return n / (A.size + B.size - n);
}

const names = (m: Pick<Meeting, "participants">) => new Set(m.participants.map((p) => p.toLowerCase().trim().split(/\s+/)[0]).filter(Boolean));

/**
 * The same meeting from two recorders: starts within ±10 minutes and alike titles. When either
 * title is generic (nothing left after filler words), a shared participant or starts within
 * 3 minutes stand in for the title. Two Wispr Flow meetings are never merged: Wispr keeps them apart itself.
 */
export function isSameMeeting(a: Pick<Meeting, "title" | "startedAt" | "participants" | "provider">, b: Pick<Meeting, "title" | "startedAt" | "participants" | "provider">): boolean {
  if (providerOf(a) === "wispr_flow" && providerOf(b) === "wispr_flow") return false;
  const gap = Math.abs(Date.parse(a.startedAt) - Date.parse(b.startedAt));
  if (!Number.isFinite(gap) || gap > DEDUPE_WINDOW_MS) return false;
  if (titleSimilarity(a.title, b.title) >= TITLE_SIMILARITY) return true;
  if (!titleWords(a.title).size || !titleWords(b.title).size) {
    if (gap <= GENERIC_WINDOW_MS) return true;
    const A = names(a), B = names(b);
    for (const n of A) if (B.has(n)) return true;
  }
  return false;
}

/** An already-stored meeting that `m` is a copy of, if any. The earliest such meeting wins. */
export async function findDuplicate(store: Pick<Store, "listMeetingsBetween">, m: Meeting): Promise<Meeting | null> {
  const t = Date.parse(m.startedAt);
  if (!Number.isFinite(t)) return null;
  const near = await store.listMeetingsBetween(
    m.userId,
    new Date(t - DEDUPE_WINDOW_MS).toISOString(),
    new Date(t + DEDUPE_WINDOW_MS + 1).toISOString(),
  );
  const same = near.filter((o) => o.id !== m.id && !o.duplicateOf && isSameMeeting(o, m));
  return same.sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0] ?? null;
}

/**
 * After queuing a new meeting: if another recorder already brought it in, close this copy
 * without a read. Returns the kept meeting's id, or null. Never throws.
 */
export async function dedupeNewMeeting(store: Pick<Store, "listMeetingsBetween" | "markMeetingDuplicate">, m: Meeting, at: string): Promise<string | null> {
  if (!store.markMeetingDuplicate || m.processedAt) return null;
  try {
    const keep = await findDuplicate(store, m);
    if (!keep) return null;
    await store.markMeetingDuplicate(m.id, keep.id, at);
    return keep.id;
  } catch (e) {
    console.error(`[dedupe] ${e instanceof Error ? e.name : "Error"}`);
    return null;
  }
}
