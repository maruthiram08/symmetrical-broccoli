import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { OAuthClientInformationMixed } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { CalendarCache, Connection, Health, Item, LastLook, Meeting, UpcomingCache, User } from "@/lib/types";
import { MemoryStore } from "@/server/store";
import { isManual, migrateItem, type ManualInput } from "@/lib/capture/items";
import type { OAuthClientStore } from "@/server/wispr/oauth";

interface State {
  version: 1;
  users: User[];
  connections: Connection[];
  meetings: Meeting[];
  items: Item[];
  briefs: Array<[string, { date: string; markdown: string; sentAt: string | null; emailId: string | null }]>;
  oauthClients: Array<[string, OAuthClientInformationMixed]>;
  events: Array<Record<string, unknown>>;
  /** Added after v1 shipped: missing in older files, which still load. */
  looks?: Array<[string, LastLook]>;
  /** Items the user marked Done/Wrong by hand before a re-read; re-applied to matching new items. */
  marks?: Mark[];
  /** Added with the prep card: missing in older files. */
  upcoming?: Array<[string, UpcomingCache]>;
  prepNotified?: string[];
  /** Added with calendar features: missing in older files. */
  calendar?: Array<[string, CalendarCache]>;
  /** Added with the Health section: missing in older files. */
  health?: Health;
  /** Set when state.json couldn't be read and was restored; shown as a banner until dismissed. */
  recovery?: Recovery | null;
}

/** What happened when state.json couldn't be read. */
export interface Recovery {
  at: string;
  /** The backup the data came back from (file name), or null when there was none and the app started empty. */
  from: string | null;
  /** Where the unreadable file was kept (file name in the data folder). */
  corruptFile: string | null;
}

/** Rolling copies of the last good state: hourly and daily. Tried in this order after a bad read. */
export const BACKUPS: Array<{ suffix: string; everyMs: number }> = [
  { suffix: ".bak", everyMs: 60 * 60_000 },
  { suffix: ".bak-daily", everyMs: 24 * 60 * 60_000 },
];
const KEEP_CORRUPT = 5;

class BadStateError extends Error {
  constructor(why: string) { super(why); this.name = "BadStateError"; }
}

/** Parse and sanity-check a state file. Throws BadStateError when it isn't a usable state. */
export function parseState(text: string): State {
  let s: unknown;
  try {
    s = JSON.parse(text);
  } catch {
    throw new BadStateError("not valid JSON");
  }
  const o = s as Partial<State> | null;
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new BadStateError("not an object");
  for (const k of ["users", "connections", "meetings", "items", "briefs"] as const) {
    if (!Array.isArray(o[k])) throw new BadStateError(`missing ${k}`);
  }
  return o as State;
}

/** A hand-made Done/Wrong that should survive the meeting being read again. */
export interface Mark {
  userId: string;
  meetingId: string;
  kind: Item["kind"];
  text: string;
  quote: string;
  /** "open" only when the mark keeps a star or snooze. */
  status: Item["status"];
  closedAt: string | null;
  starred?: boolean;
  snoozedUntil?: string | null;
}

const words = (s: string) =>
  new Set(s.toLowerCase().replace(/[^a-z0-9\u0900-\u097f ]+/g, " ").split(/\s+/).filter((w) => w.length > 2));

/** Word overlap (Jaccard) between two strings, 0..1. */
export function similarity(a: string, b: string): number {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / (A.size + B.size - n);
}

/**
 * Re-apply saved marks to freshly extracted items of one meeting. Each mark goes to at most one
 * item: the most similar item of the same kind, by quote or text, if similar enough.
 * Returns the marks that found no item (kept for a later read).
 */
export function applyMarks(items: Item[], marks: Mark[]): Mark[] {
  const left: Mark[] = [];
  const used = new Set<string>();
  for (const m of marks) {
    let best: Item | null = null, bestScore = 0;
    for (const i of items) {
      if (used.has(i.id) || i.kind !== m.kind || i.meetingId !== m.meetingId) continue;
      const score = Math.max(similarity(i.quote, m.quote), similarity(i.text, m.text));
      if (score > bestScore) { best = i; bestScore = score; }
    }
    if (best && bestScore >= 0.4) {
      used.add(best.id);
      Object.assign(best, { status: m.status, closedAt: m.closedAt, closedByMeetingId: null, closeQuote: null });
      if (m.starred) best.starred = true;
      if (m.snoozedUntil) best.snoozedUntil = m.snoozedUntil;
    } else left.push(m);
  }
  return left;
}

const MAX_EVENTS = 2000;
const MAX_PREP_NOTIFIED = 500;

/**
 * The local app's store: everything in one JSON file, written atomically after every change.
 * Small on purpose: a year of meetings is a few MB. The v1.1 desktop app moves this to SQLite.
 * Only this user's machine can read it (0600). Transcripts are never in it.
 */
export class FileStore extends MemoryStore implements OAuthClientStore {
  oauthClients = new Map<string, OAuthClientInformationMixed>();
  marks: Mark[] = [];
  protected newId = () => randomUUID();

  recovery: Recovery | null = null;

  private loadedMtime = 0;
  private readonly clock: () => number;

  constructor(readonly path: string, opts: { now?: () => number } = {}) {
    super();
    this.clock = opts.now ?? Date.now;
    this.reload();
    if (dedupeBatches(this.items)) this.flush();
  }

  /**
   * Pick up writes made by another copy of the store (Next can load this module more than once).
   * A state.json that can't be parsed is never silently replaced: it is kept as
   * state.json.corrupt-<time>, the newest good backup is restored, and `recovery` says so.
   * A missing state.json next to a backup (deleted by hand, or lost) is restored the same way.
   */
  private reload(): void {
    if (!existsSync(this.path)) {
      if (this.loadedMtime === 0 && this.users.size === 0 && BACKUPS.some((b) => existsSync(this.path + b.suffix))) this.recover(false);
      return;
    }
    const mtime = statSync(this.path).mtimeMs;
    if (mtime === this.loadedMtime) return;
    let s: State;
    try {
      s = parseState(readFileSync(this.path, "utf8"));
    } catch (e) {
      if (!(e instanceof BadStateError)) throw e;
      this.recover(true);
      return;
    }
    this.apply(s);
    this.loadedMtime = mtime;
  }

  private recover(corrupt: boolean): void {
    const at = new Date(this.clock()).toISOString();
    let corruptFile: string | null = null;
    if (corrupt) {
      corruptFile = `${basename(this.path)}.corrupt-${at.replace(/[:.]/g, "-")}`;
      copyFileSync(this.path, join(dirname(this.path), corruptFile));
      this.pruneCorrupt();
    }
    for (const b of BACKUPS) {
      const p = this.path + b.suffix;
      if (!existsSync(p)) continue;
      try {
        this.apply(parseState(readFileSync(p, "utf8")));
      } catch {
        continue;
      }
      this.recovery = { at, from: basename(p), corruptFile };
      console.error(`[store] ${basename(this.path)} ${corrupt ? "couldn't be read" : "was missing"}; restored from ${basename(p)}${corruptFile ? `, kept the bad file as ${corruptFile}` : ""}`);
      this.flush();
      return;
    }
    // Nothing to restore from. Start empty, but keep the bad copy and say so on every page.
    this.apply({ version: 1, users: [], connections: [], meetings: [], items: [], briefs: [], oauthClients: [], events: [] });
    this.recovery = { at, from: null, corruptFile };
    console.error(`[store] ${basename(this.path)} couldn't be read and there is no backup; kept it as ${corruptFile}, starting empty`);
    this.flush();
  }

  private pruneCorrupt(): void {
    try {
      const dir = dirname(this.path);
      const prefix = `${basename(this.path)}.corrupt-`;
      const old = readdirSync(dir).filter((f) => f.startsWith(prefix)).sort();
      for (const f of old.slice(0, Math.max(0, old.length - KEEP_CORRUPT))) unlinkSync(join(dir, f));
    } catch {
      // best effort
    }
  }

  private apply(s: State): void {
    this.users = new Map(s.users.map((u) => [u.id, u]));
    this.connections = new Map(s.connections.map((c) => [c.userId, c]));
    this.meetings = new Map(s.meetings.map((m) => [m.id, m]));
    this.items = new Map(s.items.map((i) => [i.id, migrateItem(i)]));
    this.briefs = new Map(s.briefs);
    this.oauthClients = new Map(s.oauthClients ?? []);
    this.events = s.events ?? [];
    this.looks = new Map(s.looks ?? []);
    this.marks = s.marks ?? [];
    this.upcoming = new Map(s.upcoming ?? []);
    this.prepNotified = new Set(s.prepNotified ?? []);
    this.calendar = new Map(s.calendar ?? []);
    this.health = s.health ?? {};
    this.recovery = s.recovery ?? null;
  }

  /** Write the whole state. Synchronous so two jobs can't interleave half-written files. */
  flush(): void {
    const state: State = {
      version: 1,
      users: [...this.users.values()],
      connections: [...this.connections.values()],
      meetings: [...this.meetings.values()],
      items: [...this.items.values()],
      briefs: [...this.briefs.entries()],
      oauthClients: [...this.oauthClients.entries()],
      events: this.events.slice(-MAX_EVENTS),
      looks: [...this.looks.entries()],
      marks: this.marks,
      upcoming: [...this.upcoming.entries()],
      prepNotified: [...this.prepNotified].slice(-MAX_PREP_NOTIFIED),
      calendar: [...this.calendar.entries()],
      health: this.health,
      recovery: this.recovery,
    };
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const json = JSON.stringify(state);
    writeAtomic(this.path, json);
    this.loadedMtime = statSync(this.path).mtimeMs;
    // After starting empty with nothing to restore, don't let the empty state replace old backups.
    if (!this.recovery || this.recovery.from) this.backup(json);
  }

  /** Refresh each rolling backup that is older than its interval. Never throws. */
  private backup(json: string): void {
    for (const b of BACKUPS) {
      const p = this.path + b.suffix;
      try {
        if (existsSync(p) && this.clock() - statSync(p).mtimeMs < b.everyMs) continue;
        writeAtomic(p, json);
      } catch (e) {
        console.error(`[store] couldn't write ${basename(p)}: ${e instanceof Error ? e.name : "Error"}`);
      }
    }
  }

  // Reads: refresh from disk first.
  async listUsers() { this.reload(); return super.listUsers(); }
  async getUser(id: string) { this.reload(); return super.getUser(id); }
  async getConnection(userId: string) { this.reload(); return super.getConnection(userId); }
  async listUnprocessedMeetings(userId: string) { this.reload(); return super.listUnprocessedMeetings(userId); }
  async listMeetingsBetween(userId: string, a: string, b: string) { this.reload(); return super.listMeetingsBetween(userId, a, b); }
  async getMeeting(id: string) { this.reload(); return super.getMeeting(id); }
  async listItems(userId: string, filter?: { status?: Item["status"] }) { this.reload(); return super.listItems(userId, filter); }
  async getBrief(userId: string, date: string) { this.reload(); return super.getBrief(userId, date); }
  /** Logged events, oldest first, optionally of one type (e.g. "handoff"). */
  async listEvents(type?: string) { this.reload(); return type ? this.events.filter((e) => e.type === type) : [...this.events]; }
  async listBriefs(userId: string) { this.reload(); return super.listBriefs(userId); }

  addUser(u: Partial<User> & { email: string }): User {
    this.reload();
    const user = super.addUser(u);
    this.flush();
    return user;
  }
  async updateUser(id: string, patch: Partial<Omit<User, "id">>): Promise<User | null> {
    this.reload();
    const u = this.users.get(id);
    if (!u) return null;
    Object.assign(u, patch);
    this.flush();
    return u;
  }
  async saveConnection(c: Connection) { this.reload(); await super.saveConnection(c); this.flush(); }
  async upsertMeeting(m: Omit<Meeting, "id" | "processedAt">) {
    this.reload();
    const r = await super.upsertMeeting(m);
    if (r.created) this.flush();
    return r;
  }
  async commitExtraction(args: Parameters<MemoryStore["commitExtraction"]>[0]) {
    this.reload();
    const m = this.meetings.get(args.meetingId);
    if (m?.processedAt) return; // idempotent: a meeting is only ever committed once
    await super.commitExtraction(args);
    const mine = this.marks.filter((k) => k.meetingId === args.meetingId);
    if (mine.length) {
      const fresh = [...this.items.values()].filter((i) => i.meetingId === args.meetingId && i.createdAt === args.at && i.status === "open");
      const left = applyMarks(fresh, mine);
      this.marks = [...this.marks.filter((k) => k.meetingId !== args.meetingId), ...left];
    }
    this.flush();
  }
  async setItemStatus(itemId: string, status: Item["status"], at: string) { this.reload(); await super.setItemStatus(itemId, status, at); this.flush(); }
  async addManualItem(userId: string, input: ManualInput, at: string) { this.reload(); const i = await super.addManualItem(userId, input, at); this.flush(); return i; }
  async updateItem(...a: Parameters<MemoryStore["updateItem"]>) { this.reload(); const i = await super.updateItem(...a); if (i) this.flush(); return i; }
  async deleteItem(itemId: string) { this.reload(); const ok = await super.deleteItem(itemId); if (ok) this.flush(); return ok; }
  async saveBrief(...a: Parameters<MemoryStore["saveBrief"]>) { this.reload(); await super.saveBrief(...a); this.flush(); }
  async logEvent(e: Parameters<MemoryStore["logEvent"]>[0]) { this.reload(); await super.logEvent({ ...e, at: new Date().toISOString() }); this.flush(); }
  async getLastLook(userId: string) { this.reload(); return super.getLastLook(userId); }
  async saveLastLook(userId: string, look: LastLook) { this.reload(); await super.saveLastLook(userId, look); this.flush(); }
  async saveUpcoming(userId: string, cache: UpcomingCache) { this.reload(); await super.saveUpcoming(userId, cache); this.flush(); }
  async getUpcoming(userId: string) { this.reload(); return super.getUpcoming(userId); }
  async saveCalendar(userId: string, cache: CalendarCache) { this.reload(); await super.saveCalendar(userId, cache); this.flush(); }
  async getCalendar(userId: string) { this.reload(); return super.getCalendar(userId); }
  async setItemDue(userId: string, itemId: string, dueAt: string | null) { this.reload(); const ok = await super.setItemDue(userId, itemId, dueAt); if (ok) this.flush(); return ok; }
  async markPrepNotified(key: string) { this.reload(); const fresh = await super.markPrepNotified(key); if (fresh) this.flush(); return fresh; }
  async deleteUser(userId: string) { this.reload(); await super.deleteUser(userId); this.oauthClients.delete(userId); this.flush(); }

  /**
   * Forget every extracted item and mark all meetings unread, so they can be read again oldest
   * first (later meetings then close earlier promises). Meetings and the connection are kept, and so are hand-made Done/Wrong marks (see applyMarks).
   */
  async resetExtraction(userId: string): Promise<number> {
    this.reload();
    // Keep what the user marked by hand so the re-read doesn't undo it.
    for (const i of this.items.values()) {
      if (i.userId !== userId || isManual(i)) continue;
      if ((i.status !== "open" && !i.closedByMeetingId) || i.starred || i.snoozedUntil) {
        const status = i.closedByMeetingId ? "open" : i.status; // a close by a meeting comes back on the re-read
        this.marks.push({ userId, meetingId: i.meetingId, kind: i.kind, text: i.text, quote: i.quote, status, closedAt: status === "open" ? null : i.closedAt, starred: i.starred || undefined, snoozedUntil: i.snoozedUntil || undefined });
      }
    }
    // Your own items aren't read from meetings: they stay.
    for (const [id, i] of this.items) if (i.userId === userId && !isManual(i)) this.items.delete(id);
    let n = 0;
    for (const m of this.meetings.values()) if (m.userId === userId) { m.processedAt = null; n++; }
    this.flush();
    return n;
  }

  async getHealth() { this.reload(); return super.getHealth(); }
  async setHealth(patch: Partial<Health>) { this.reload(); await super.setHealth(patch); this.flush(); }
  async recordMeetingFailure(meetingId: string, failure: string, at: string) { this.reload(); await super.recordMeetingFailure(meetingId, failure, at); this.flush(); }
  async resetMeetingFailures(userId: string) { this.reload(); const n = await super.resetMeetingFailures(userId); if (n) this.flush(); return n; }
  /** The "restored from backup" notice, until the user dismisses it. */
  async getRecovery() { this.reload(); return this.recovery; }
  async dismissRecovery() { this.reload(); if (this.recovery) { this.recovery = null; this.flush(); } }

  async getOAuthClient(userId: string) { this.reload(); return this.oauthClients.get(userId) ?? null; }
  async saveOAuthClient(userId: string, info: OAuthClientInformationMixed) { this.reload(); this.oauthClients.set(userId, info); this.flush(); }
}

/** Write to <path>.tmp, then rename over path: a reader never sees half a file. Private mode. */
function writeAtomic(path: string, data: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

/**
 * A meeting read twice leaves two batches of items with different createdAt. Keep the first batch
 * (and any batch whose items the user already acted on). Returns true if anything was removed.
 */
export function dedupeBatches(items: Map<string, Item>): boolean {
  const byMeeting = new Map<string, Map<string, Item[]>>();
  for (const i of items.values()) {
    if (isManual(i)) continue; // your own items have no meeting batch
    const batches = byMeeting.get(i.meetingId) ?? new Map<string, Item[]>();
    batches.set(i.createdAt, [...(batches.get(i.createdAt) ?? []), i]);
    byMeeting.set(i.meetingId, batches);
  }
  let removed = false;
  for (const batches of byMeeting.values()) {
    if (batches.size < 2) continue;
    const ordered = [...batches.entries()].sort(([a], [b]) => a.localeCompare(b));
    for (const [, batch] of ordered.slice(1)) {
      if (batch.some((i) => i.status !== "open" && !i.closedByMeetingId)) continue; // user touched it: keep
      for (const i of batch) items.delete(i.id);
      removed = true;
    }
  }
  return removed;
}
