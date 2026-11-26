// Granola (granola.ai) keeps a local cache of your meetings on macOS. We read it, never write it.
//
// ASSUMED SHAPE (not a public API; read from community tools and the app's files in late 2026,
// so every field is optional and anything unexpected is skipped rather than failing):
//
//   ~/Library/Application Support/Granola/cache-v3.json   (newer builds: cache-v4.json, ...)
//   {
//     "cache": "<JSON string>"          // older builds: a string to parse again; newer: the object
//   }
//   cache = {
//     "state": {
//       "documents": {                  // or an array of documents
//         "<docId>": {
//           "id": "<docId>", "title": "Pricing review", "type": "meeting",
//           "created_at": "2026-11-24T04:30:00.000Z", "updated_at": "...", "deleted_at": null,
//           "google_calendar_event": { "summary": "...", "start": { "dateTime": "..." }, "end": { "dateTime": "..." },
//                                      "attendees": [{ "email": "...", "displayName": "..." }] },
//           "people": { "attendees": [{ "name": "...", "email": "..." }] }
//         }
//       },
//       "transcripts": {                // segments per document; may be missing for older meetings
//         "<docId>": [ { "document_id": "<docId>", "start_timestamp": "...", "end_timestamp": "...",
//                        "text": "...", "source": "microphone" | "system", "is_final": true } ]
//       }
//     }
//   }
//
// "microphone" is you; "system" is everyone else on the call (Granola doesn't separate them).
// The cache file may be missing, half-written or a shape we don't know: the source then shows
// "not found" or "couldn't read" and nothing else happens.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { renderTurns, type Turn } from "./parse/common";

export interface GranolaSegment {
  text: string;
  startedAt: string | null;
  endedAt: string | null;
  /** true: the user's microphone. false: the other side. */
  mine: boolean;
}

export interface GranolaDoc {
  id: string;
  title: string;
  startedAt: string;
  participants: string[];
  segments: GranolaSegment[];
  /** End of the last segment, for "is it still going?". */
  lastAt: string | null;
}

/** Granola's folder. GRANOLA_DIR overrides it (tests, other machines). */
export function granolaDir(): string {
  return process.env.GRANOLA_DIR ?? join(homedir(), "Library", "Application Support", "Granola");
}

/**
 * The cache file to read: `path` when it is a file, else the highest-numbered cache-v*.json in
 * the folder (`path` or Granola's own). Null when there is none. Never throws.
 */
export function findGranolaCache(path?: string | null): string | null {
  const p = path || granolaDir();
  try {
    const st = statSync(p);
    if (st.isFile()) return p;
    if (!st.isDirectory()) return null;
    const best = readdirSync(p)
      .map((f) => ({ f, v: /^cache-v(\d+)\.json$/.exec(f) }))
      .filter((x) => x.v)
      .sort((a, b) => Number(b.v![1]) - Number(a.v![1]))[0];
    return best ? join(p, best.f) : null;
  } catch {
    return null;
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const iso = (v: unknown): string | null => {
  const s = str(v) ?? (typeof v === "number" ? new Date(v > 1e12 ? v : v * 1000).toISOString() : null);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

export class GranolaCacheError extends Error {
  constructor(why: string) { super(why); this.name = "GranolaCacheError"; }
}

/** Unwrap {cache: "<json>"} / {cache: {...}} / {state: ...} down to the state object. */
function stateOf(raw: string): Obj {
  let top: unknown;
  try { top = JSON.parse(raw); } catch { throw new GranolaCacheError("not JSON"); }
  let c: unknown = isObj(top) && "cache" in top ? top.cache : top;
  if (typeof c === "string") {
    try { c = JSON.parse(c); } catch { throw new GranolaCacheError("inner cache not JSON"); }
  }
  if (!isObj(c)) throw new GranolaCacheError("no cache object");
  const state = isObj(c.state) ? c.state : c;
  if (!("documents" in state)) throw new GranolaCacheError("no documents");
  return state;
}

function people(doc: Obj): string[] {
  const out: string[] = [];
  const add = (name: unknown, email: unknown) => {
    const n = str(name) ?? str(email);
    if (n && !out.some((o) => o.toLowerCase() === n.toLowerCase())) out.push(n);
  };
  const cal = isObj(doc.google_calendar_event) ? doc.google_calendar_event : null;
  if (cal && Array.isArray(cal.attendees)) for (const a of cal.attendees) if (isObj(a)) add(a.displayName ?? a.name, a.email);
  const ppl = isObj(doc.people) ? doc.people : null;
  if (ppl && Array.isArray(ppl.attendees)) for (const a of ppl.attendees) if (isObj(a)) add(a.name ?? (isObj(a.details) && isObj(a.details.person) && isObj(a.details.person.name) ? a.details.person.name.fullName : null), a.email);
  return out;
}

function segmentsOf(v: unknown): GranolaSegment[] {
  const list = Array.isArray(v) ? v : isObj(v) && Array.isArray(v.segments) ? v.segments : [];
  const out: GranolaSegment[] = [];
  for (const s of list) {
    if (!isObj(s)) continue;
    const text = str(s.text) ?? str(s.content);
    if (!text || s.is_final === false) continue;
    const source = str(s.source)?.toLowerCase();
    out.push({
      text,
      startedAt: iso(s.start_timestamp ?? s.startTimestamp ?? s.start),
      endedAt: iso(s.end_timestamp ?? s.endTimestamp ?? s.end),
      mine: source === "microphone" || source === "mic" || source === "me",
    });
  }
  return out.sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));
}

/** Every meeting in a Granola cache that has a transcript, oldest first. Throws GranolaCacheError on an unknown shape. */
export function parseGranolaCache(raw: string): GranolaDoc[] {
  const state = stateOf(raw);
  const docsRaw = state.documents;
  const docs: Obj[] = Array.isArray(docsRaw) ? docsRaw.filter(isObj) : isObj(docsRaw) ? Object.entries(docsRaw).flatMap(([k, d]): Obj[] => (isObj(d) ? [{ id: k, ...d }] : [])) : [];
  const transcripts = isObj(state.transcripts) ? state.transcripts : {};
  const out: GranolaDoc[] = [];
  for (const d of docs) {
    const id = str(d.id);
    if (!id || d.deleted_at || (str(d.type) && str(d.type) !== "meeting")) continue;
    const segments = segmentsOf(transcripts[id]);
    if (!segments.length) continue; // notes only: nothing to read
    const cal = isObj(d.google_calendar_event) ? d.google_calendar_event : null;
    const startedAt = iso(cal && isObj(cal.start) ? cal.start.dateTime : null) ?? segments[0].startedAt ?? iso(d.created_at);
    if (!startedAt) continue;
    const title = str(d.title) ?? str(cal?.summary) ?? "Granola meeting";
    const lastAt = segments.reduce<string | null>((a, s) => { const t = s.endedAt ?? s.startedAt; return t && (!a || t > a) ? t : a; }, null);
    out.push({ id, title, startedAt, participants: people(d), segments, lastAt });
  }
  return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/** One meeting's transcript as "Speaker: text" lines. The microphone side is labelled with your name. */
export function granolaTranscript(doc: GranolaDoc, you: string): string {
  const turns: Turn[] = doc.segments.map((s) => ({ speaker: s.mine ? you || "Me" : "Them", text: s.text }));
  return renderTurns(turns);
}

/** Parsed caches by path and file version, so an unchanged cache is parsed once. */
const parsed = new Map<string, { sig: string; docs: GranolaDoc[] }>();

/** Read and parse a cache file, reusing the last parse while the file is unchanged. Throws when unreadable. */
export function readGranolaCache(file: string): GranolaDoc[] {
  const st = statSync(file);
  const sig = `${st.ino}:${st.size}:${st.mtimeMs}`;
  const hit = parsed.get(file);
  if (hit && hit.sig === sig) return hit.docs;
  const docs = parseGranolaCache(readFileSync(file, "utf8"));
  parsed.set(file, { sig, docs });
  return docs;
}

/** For Settings: how many meetings with a transcript the cache holds, or why it can't say. */
export function granolaStatus(path?: string | null): { file: string | null; found: number | null; error: string | null } {
  const file = findGranolaCache(path);
  if (!file || !existsSync(file)) return { file: null, found: null, error: null };
  try {
    return { file, found: readGranolaCache(file).length, error: null };
  } catch (e) {
    return { file, found: null, error: e instanceof GranolaCacheError ? `couldn't read ${basename(file)} (${e.message})` : `couldn't read ${basename(file)}` };
  }
}
