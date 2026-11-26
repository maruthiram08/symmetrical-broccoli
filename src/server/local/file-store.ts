import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { OAuthClientInformationMixed } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { CalendarCache, Connection, Health, Item, LastLook, Meeting, UpcomingCache, User } from "@/lib/types";
import { MemoryStore } from "@/server/store";
import { isManual, migrateItem, type ManualInput } from "@/lib/capture/items";
import type { OAuthClientStore } from "@/server/wispr/oauth";
import type { ChangeCtx, Directory, PeopleChange } from "@/lib/directory/directory";

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
  /** Added with the people directory: missing in older files (names then show as extracted). */
  people?: Array<[string, Directory]>;
  peopleLog?: Array<[string, PeopleChange[]]>;
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
/** A state.json that doesn't parse is read again this many times, this far apart, before it counts as damaged. */
const READ_RETRIES = 3;
const READ_RETRY_MS = 100;
/** How many times a change is made again because another process wrote state.json meanwhile. */
const CHANGE_RETRIES = 5;
/** `Recovery.from` when the damaged file was written again from the state this process had open. */
export const RECOVERED_FROM_MEMORY = "memory";

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
/** How alike two items of one meeting must be to count as the same item read twice. */
const DUPLICATE_SIMILARITY = 0.6;
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

  /** The file as this copy last read or wrote it; null before the first good read. */
  private loaded: FileSig | null = null;
  /** Counts recover() calls, so change() can tell its own reload restored the file. */
  private recoveries = 0;
  private readonly clock: () => number;

  constructor(readonly path: string, opts: { now?: () => number } = {}) {
    super();
    this.clock = opts.now ?? Date.now;
    this.reload();
    if (dedupeBatches(this.items)) this.flush();
  }

  /**
   * Pick up writes made by another copy of the store: another module copy in this process, the
   * MCP server, a second app process, or a hand edit. A change is seen by inode (every atomic write
   * is a new file), size or mtime, so two writes within one timestamp tick are not missed.
   * A state.json that can't be parsed is never silently replaced: it is read again after a moment
   * (someone may be writing it in place), then kept as state.json.corrupt-<time> and restored from
   * this copy's own state when it has one, else from the newest good backup; `recovery` says so.
   * A missing state.json next to a backup (deleted by hand, or lost) is restored the same way.
   */
  private reload(): void {
    let sig = fileSig(this.path);
    if (!sig) {
      if (!this.loaded && this.users.size === 0 && BACKUPS.some((b) => existsSync(this.path + b.suffix))) this.recover(false);
      return;
    }
    if (sameSig(sig, this.loaded)) return;
    for (let attempt = 0; ; attempt++) {
      try {
        this.apply(parseState(readFileSync(this.path, "utf8")));
        this.loaded = sig;
        return;
      } catch (e) {
        if (!(e instanceof BadStateError) && (e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        if (attempt >= READ_RETRIES) break;
      }
      sleepSync(READ_RETRY_MS);
      sig = fileSig(this.path);
      if (!sig) return; // gone while we waited: handled on the next read
    }
    if (fileSig(this.path)) this.recover(true);
  }

  private recover(corrupt: boolean): void {
    this.recoveries++;
    const at = new Date(this.clock()).toISOString();
    let corruptFile: string | null = null;
    if (corrupt) {
      corruptFile = `${basename(this.path)}.corrupt-${at.replace(/[:.]/g, "-")}`;
      copyFileSync(this.path, join(dirname(this.path), corruptFile));
      this.pruneCorrupt();
    }
    // This copy already holds a good state at least as new as any backup: write that back rather
    // than rolling back to a backup that may be an hour (or a day) older.
    if (corrupt && this.loaded) {
      this.recovery = { at, from: RECOVERED_FROM_MEMORY, corruptFile };
      console.error(`[store] ${basename(this.path)} couldn't be read; wrote it again from the copy in memory, kept the bad file as ${corruptFile}`);
      this.flush();
      return;
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
    // Meetings stored before recorders existed all came from Wispr Flow.
    this.meetings = new Map(s.meetings.map((m) => [m.id, m.provider ? m : { ...m, provider: "wispr_flow" as const }]));
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
    this.people = new Map((s.people ?? []).map(([k, d]) => [k, { people: d?.people ?? [], moved: d?.moved ?? {} }]));
    this.peopleLog = new Map(s.peopleLog ?? []);
  }

  /** True when state.json is no longer the file this copy last read or wrote. */
  private changedOnDisk(): boolean {
    return !sameSig(fileSig(this.path), this.loaded);
  }

  /**
   * Every change goes through here: read the file, apply the change, write the whole file. If
   * another process wrote state.json while the change was being made, the change is made again on
   * top of that version instead of writing a stale copy over it (a lost update).
   * `fn` changes only this store's maps, so running it again on fresh ones is safe.
   */
  private async change<T>(fn: () => T | Promise<T>, write: (r: T) => boolean = () => true): Promise<T> {
    let r!: T;
    for (let attempt = 0; ; attempt++) {
      const recoveries = this.recoveries;
      this.reload();
      // The other write left a damaged file, and it was written again from memory, which already
      // held this change: don't make it twice.
      if (attempt > 0 && this.recoveries !== recoveries) return r;
      r = await fn();
      if (!write(r)) return r;
      if (attempt < CHANGE_RETRIES && this.changedOnDisk()) continue;
      this.flush();
      return r;
    }
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
      people: [...this.people.entries()],
      peopleLog: [...this.peopleLog.entries()],
    };
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const json = JSON.stringify(state);
    writeAtomic(this.path, json);
    this.loaded = fileSig(this.path);
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
    // Synchronous (setup and tests call it so); same re-apply rule as change().
    for (let attempt = 0; ; attempt++) {
      this.reload();
      const user = super.addUser(u);
      if (attempt < CHANGE_RETRIES && this.changedOnDisk()) continue;
      this.flush();
      return user;
    }
  }
  async updateUser(id: string, patch: Partial<Omit<User, "id">>): Promise<User | null> {
    return this.change(() => {
      const u = this.users.get(id);
      if (u) Object.assign(u, patch);
      return u ?? null;
    }, (u) => !!u);
  }
  async saveConnection(c: Connection) { await this.change(() => super.saveConnection(c)); }
  async upsertMeeting(m: Omit<Meeting, "id" | "processedAt">) { return this.change(() => super.upsertMeeting(m), (r) => r.created); }
  async commitExtraction(args: Parameters<MemoryStore["commitExtraction"]>[0]) {
    await this.change(async () => {
      const m = this.meetings.get(args.meetingId);
      if (m?.processedAt) return false; // idempotent: a meeting is only ever committed once
      await super.commitExtraction(args);
      const mine = this.marks.filter((k) => k.meetingId === args.meetingId);
      if (mine.length) {
        const fresh = [...this.items.values()].filter((i) => i.meetingId === args.meetingId && i.createdAt === args.at && i.status === "open");
        const left = applyMarks(fresh, mine);
        this.marks = [...this.marks.filter((k) => k.meetingId !== args.meetingId), ...left];
      }
      return true;
    }, (done) => done);
  }
  async setItemStatus(itemId: string, status: Item["status"], at: string) { await this.change(() => super.setItemStatus(itemId, status, at)); }
  async addManualItem(userId: string, input: ManualInput, at: string) { return this.change(() => super.addManualItem(userId, input, at)); }
  async updateItem(...a: Parameters<MemoryStore["updateItem"]>) { return this.change(() => super.updateItem(...a), (i) => !!i); }
  async setItemTicket(...a: Parameters<MemoryStore["setItemTicket"]>) { return this.change(() => super.setItemTicket(...a), (i) => !!i); }
  async closeItemWithReason(...a: Parameters<MemoryStore["closeItemWithReason"]>) { return this.change(() => super.closeItemWithReason(...a), (ok) => ok); }
  async deleteItem(itemId: string) { return this.change(() => super.deleteItem(itemId), (ok) => ok); }
  async saveBrief(...a: Parameters<MemoryStore["saveBrief"]>) { await this.change(() => super.saveBrief(...a)); }
  async logEvent(e: Parameters<MemoryStore["logEvent"]>[0]) { const at = new Date().toISOString(); await this.change(() => super.logEvent({ ...e, at })); }
  async getLastLook(userId: string) { this.reload(); return super.getLastLook(userId); }
  async saveLastLook(userId: string, look: LastLook) { await this.change(() => super.saveLastLook(userId, look)); }
  async saveUpcoming(userId: string, cache: UpcomingCache) { await this.change(() => super.saveUpcoming(userId, cache)); }
  async getUpcoming(userId: string) { this.reload(); return super.getUpcoming(userId); }
  async saveCalendar(userId: string, cache: CalendarCache) { await this.change(() => super.saveCalendar(userId, cache)); }
  async getCalendar(userId: string) { this.reload(); return super.getCalendar(userId); }
  async setItemDue(userId: string, itemId: string, dueAt: string | null) { return this.change(() => super.setItemDue(userId, itemId, dueAt), (ok) => ok); }
  async markPrepNotified(key: string) { return this.change(() => super.markPrepNotified(key), (fresh) => fresh); }
  async deleteUser(userId: string) { await this.change(async () => { await super.deleteUser(userId); this.oauthClients.delete(userId); }); }

  /**
   * Forget every extracted item and mark all meetings unread, so they can be read again oldest
   * first (later meetings then close earlier promises). Meetings and the connection are kept, and so are hand-made Done/Wrong marks (see applyMarks).
   */
  async resetExtraction(userId: string): Promise<number> {
    return this.change(() => this.resetExtractionInMemory(userId));
  }

  private resetExtractionInMemory(userId: string): number {
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
    return n;
  }

  async getPeople(userId: string) { this.reload(); return super.getPeople(userId); }
  async listPeopleChanges(userId: string) { this.reload(); return super.listPeopleChanges(userId); }
  async changePeople(userId: string, plan: (d: Directory, ctx: ChangeCtx) => PeopleChange | null, at: string) {
    return this.change(() => super.changePeople(userId, plan, at), (c) => !!c);
  }
  async undoPeopleChange(userId: string, changeId: string) { return this.change(() => super.undoPeopleChange(userId, changeId), (c) => !!c); }
  async getHealth() { this.reload(); return super.getHealth(); }
  async setHealth(patch: Partial<Health>) { await this.change(() => super.setHealth(patch)); }
  async markMeetingDuplicate(meetingId: string, duplicateOf: string, at: string) { await this.change(() => super.markMeetingDuplicate(meetingId, duplicateOf, at)); }
  async recordMeetingFailure(meetingId: string, failure: string, at: string) { await this.change(() => super.recordMeetingFailure(meetingId, failure, at)); }
  async resetMeetingFailures(userId: string) { return this.change(() => super.resetMeetingFailures(userId), (n) => n > 0); }
  /** The "restored from backup" notice, until the user dismisses it. */
  async getRecovery() { this.reload(); return this.recovery; }
  async dismissRecovery() { await this.change(() => { const had = !!this.recovery; this.recovery = null; return had; }, (had) => had); }

  async getOAuthClient(userId: string) { this.reload(); return this.oauthClients.get(userId) ?? null; }
  async saveOAuthClient(userId: string, info: OAuthClientInformationMixed) { await this.change(() => { this.oauthClients.set(userId, info); }); }
}

/** What identifies one version of a file on disk. */
interface FileSig { ino: number; size: number; mtimeMs: number }

function fileSig(path: string): FileSig | null {
  try {
    const st = statSync(path);
    return { ino: st.ino, size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

const sameSig = (a: FileSig | null, b: FileSig | null) =>
  a === b || (!!a && !!b && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs);

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Write to <path>.tmp, then rename over path: a reader never sees half a file. Private mode. */
function writeAtomic(path: string, data: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** The same item read twice: same kind, and the same text or quote, or both very alike. */
function sameItem(a: Item, b: Item): boolean {
  if (a.kind !== b.kind) return false;
  if (norm(a.text) === norm(b.text) || (a.quote && norm(a.quote) === norm(b.quote))) return true;
  return similarity(a.text, b.text) >= DUPLICATE_SIMILARITY && similarity(a.quote, b.quote) >= DUPLICATE_SIMILARITY;
}

/**
 * A meeting read twice leaves two batches of items with different createdAt. Keep the first batch,
 * and remove an item of a later batch only when it is a copy: an untouched open item with a
 * matching item (see sameItem) in the first batch. An item with no such copy
 * is never removed, so a batch that only looks like a re-read (an item added by hand, by another
 * tool or by a later feature with its own createdAt) loses nothing. Returns true if anything was removed.
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
    const [[, first], ...later] = [...batches.entries()].sort(([a], [b]) => a.localeCompare(b));
    const used = new Set<string>();
    for (const [, batch] of later) {
      for (const i of batch) {
        if (i.status !== "open" || i.starred || i.snoozedUntil || i.note) continue; // touched: keep
        const copy = first.find((f) => !used.has(f.id) && sameItem(f, i));
        if (!copy) continue; // the only copy: keep
        used.add(copy.id);
        items.delete(i.id);
        removed = true;
      }
    }
  }
  return removed;
}
