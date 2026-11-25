import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { OAuthClientInformationMixed } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Connection, Item, LastLook, Meeting, UpcomingCache, User } from "@/lib/types";
import { MemoryStore } from "@/server/store";
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
}

/** A hand-made Done/Wrong that should survive the meeting being read again. */
export interface Mark {
  userId: string;
  meetingId: string;
  kind: Item["kind"];
  text: string;
  quote: string;
  status: Exclude<Item["status"], "open">;
  closedAt: string | null;
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

  private loadedMtime = 0;

  constructor(readonly path: string) {
    super();
    this.reload();
    if (dedupeBatches(this.items)) this.flush();
  }

  /** Pick up writes made by another copy of the store (Next can load this module more than once). */
  private reload(): void {
    if (!existsSync(this.path)) return;
    const mtime = statSync(this.path).mtimeMs;
    if (mtime === this.loadedMtime) return;
    const s = JSON.parse(readFileSync(this.path, "utf8")) as State;
    this.users = new Map(s.users.map((u) => [u.id, u]));
    this.connections = new Map(s.connections.map((c) => [c.userId, c]));
    this.meetings = new Map(s.meetings.map((m) => [m.id, m]));
    this.items = new Map(s.items.map((i) => [i.id, i]));
    this.briefs = new Map(s.briefs);
    this.oauthClients = new Map(s.oauthClients ?? []);
    this.events = s.events ?? [];
    this.looks = new Map(s.looks ?? []);
    this.marks = s.marks ?? [];
    this.upcoming = new Map(s.upcoming ?? []);
    this.prepNotified = new Set(s.prepNotified ?? []);
    this.loadedMtime = mtime;
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
    };
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    renameSync(tmp, this.path);
    chmodSync(this.path, 0o600);
    this.loadedMtime = statSync(this.path).mtimeMs;
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
  async saveBrief(...a: Parameters<MemoryStore["saveBrief"]>) { this.reload(); await super.saveBrief(...a); this.flush(); }
  async logEvent(e: Parameters<MemoryStore["logEvent"]>[0]) { this.reload(); await super.logEvent({ ...e, at: new Date().toISOString() }); this.flush(); }
  async getLastLook(userId: string) { this.reload(); return super.getLastLook(userId); }
  async saveLastLook(userId: string, look: LastLook) { this.reload(); await super.saveLastLook(userId, look); this.flush(); }
  async saveUpcoming(userId: string, cache: UpcomingCache) { this.reload(); await super.saveUpcoming(userId, cache); this.flush(); }
  async getUpcoming(userId: string) { this.reload(); return super.getUpcoming(userId); }
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
      if (i.userId === userId && i.status !== "open" && !i.closedByMeetingId) {
        this.marks.push({ userId, meetingId: i.meetingId, kind: i.kind, text: i.text, quote: i.quote, status: i.status, closedAt: i.closedAt });
      }
    }
    for (const [id, i] of this.items) if (i.userId === userId) this.items.delete(id);
    let n = 0;
    for (const m of this.meetings.values()) if (m.userId === userId) { m.processedAt = null; n++; }
    this.flush();
    return n;
  }

  async getOAuthClient(userId: string) { this.reload(); return this.oauthClients.get(userId) ?? null; }
  async saveOAuthClient(userId: string, info: OAuthClientInformationMixed) { this.reload(); this.oauthClients.set(userId, info); this.flush(); }
}

/**
 * A meeting read twice leaves two batches of items with different createdAt. Keep the first batch
 * (and any batch whose items the user already acted on). Returns true if anything was removed.
 */
export function dedupeBatches(items: Map<string, Item>): boolean {
  const byMeeting = new Map<string, Map<string, Item[]>>();
  for (const i of items.values()) {
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
