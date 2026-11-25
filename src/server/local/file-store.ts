import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { OAuthClientInformationMixed } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Connection, Item, Meeting, User } from "@/lib/types";
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

  constructor(readonly path: string) {
    super();
    if (existsSync(path)) {
      const s = JSON.parse(readFileSync(path, "utf8")) as State;
      for (const u of s.users) this.users.set(u.id, u);
      for (const c of s.connections) this.connections.set(c.userId, c);
      for (const m of s.meetings) this.meetings.set(m.id, m);
      for (const i of s.items) this.items.set(i.id, i);
      this.briefs = new Map(s.briefs);
      this.oauthClients = new Map(s.oauthClients ?? []);
      this.events = s.events ?? [];
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
    };
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    renameSync(tmp, this.path);
    chmodSync(this.path, 0o600);
  }

  addUser(u: Partial<User> & { email: string }): User {
    const user = super.addUser(u);
    this.flush();
    return user;
  }
  async updateUser(id: string, patch: Partial<Omit<User, "id">>): Promise<User | null> {
    const u = this.users.get(id);
    if (!u) return null;
    Object.assign(u, patch);
    this.flush();
    return u;
  }
  async saveConnection(c: Connection) { await super.saveConnection(c); this.flush(); }
  async upsertMeeting(m: Omit<Meeting, "id" | "processedAt">) {
    const r = await super.upsertMeeting(m);
    if (r.created) this.flush();
    return r;
  }
  async commitExtraction(args: Parameters<MemoryStore["commitExtraction"]>[0]) {
    const m = this.meetings.get(args.meetingId);
    if (m?.processedAt) return; // idempotent: a meeting is only ever committed once
    await super.commitExtraction(args);
    this.flush();
  }
  async setItemStatus(itemId: string, status: Item["status"], at: string) { await super.setItemStatus(itemId, status, at); this.flush(); }
  async saveBrief(...a: Parameters<MemoryStore["saveBrief"]>) { await super.saveBrief(...a); this.flush(); }
  async logEvent(e: Parameters<MemoryStore["logEvent"]>[0]) { await super.logEvent({ ...e, at: new Date().toISOString() }); this.flush(); }
  async deleteUser(userId: string) { await super.deleteUser(userId); this.oauthClients.delete(userId); this.flush(); }

  async getOAuthClient(userId: string) { return this.oauthClients.get(userId) ?? null; }
  async saveOAuthClient(userId: string, info: OAuthClientInformationMixed) { this.oauthClients.set(userId, info); this.flush(); }
}
