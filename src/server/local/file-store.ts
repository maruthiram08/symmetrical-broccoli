import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { OAuthClientInformationMixed } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Connection, Item, LastLook, Meeting, User } from "@/lib/types";
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
}

const MAX_EVENTS = 2000;

/**
 * The local app's store: everything in one JSON file, written atomically after every change.
 * Small on purpose: a year of meetings is a few MB. The v1.1 desktop app moves this to SQLite.
 * Only this user's machine can read it (0600). Transcripts are never in it.
 */
export class FileStore extends MemoryStore implements OAuthClientStore {
  oauthClients = new Map<string, OAuthClientInformationMixed>();
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
    this.flush();
  }
  async setItemStatus(itemId: string, status: Item["status"], at: string) { this.reload(); await super.setItemStatus(itemId, status, at); this.flush(); }
  async saveBrief(...a: Parameters<MemoryStore["saveBrief"]>) { this.reload(); await super.saveBrief(...a); this.flush(); }
  async logEvent(e: Parameters<MemoryStore["logEvent"]>[0]) { this.reload(); await super.logEvent({ ...e, at: new Date().toISOString() }); this.flush(); }
  async getLastLook(userId: string) { this.reload(); return super.getLastLook(userId); }
  async saveLastLook(userId: string, look: LastLook) { this.reload(); await super.saveLastLook(userId, look); this.flush(); }
  async deleteUser(userId: string) { this.reload(); await super.deleteUser(userId); this.oauthClients.delete(userId); this.flush(); }

  /**
   * Forget every extracted item and mark all meetings unread, so they can be read again oldest
   * first (later meetings then close earlier promises). Meetings and the connection are kept.
   */
  async resetExtraction(userId: string): Promise<number> {
    this.reload();
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
