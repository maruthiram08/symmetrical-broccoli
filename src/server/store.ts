import type { Connection, Item, LastLook, Meeting, User } from "@/lib/types";

/**
 * Data access used by the jobs. Two implementations:
 *  - MemoryStore (tests, local eval)
 *  - SupabaseStore (production, src/server/supabase-store.ts)
 */
export interface Store {
  listUsers(): Promise<User[]>;
  getUser(id: string): Promise<User | null>;
  getConnection(userId: string): Promise<Connection | null>;
  saveConnection(c: Connection): Promise<void>;
  /** Insert if (userId, providerMeetingId) is new. Returns the meeting, new or existing. */
  upsertMeeting(m: Omit<Meeting, "id" | "processedAt">): Promise<{ meeting: Meeting; created: boolean }>;
  listUnprocessedMeetings(userId: string): Promise<Meeting[]>;
  listMeetingsBetween(userId: string, fromIso: string, toIso: string): Promise<Meeting[]>;
  getMeeting(id: string): Promise<Meeting | null>;
  /** Write new items, apply closes and mark the meeting processed, atomically. */
  commitExtraction(args: {
    meetingId: string;
    userId: string;
    newItems: Array<Omit<Item, "id" | "userId" | "status" | "closedByMeetingId" | "closeQuote" | "createdAt" | "closedAt">>;
    closes: Array<{ itemId: string; quote: string }>;
    at: string;
  }): Promise<void>;
  listItems(userId: string, filter?: { status?: Item["status"] }): Promise<Item[]>;
  setItemStatus(itemId: string, status: Item["status"], at: string): Promise<void>;
  getBrief(userId: string, date: string): Promise<{ sentAt: string | null } | null>;
  saveBrief(userId: string, date: string, markdown: string, sentAt: string | null, emailId: string | null): Promise<void>;
  listBriefs(userId: string): Promise<Array<{ date: string; markdown: string }>>;
  logEvent(e: { userId: string | null; type: string; payload?: unknown; tokensIn?: number; tokensOut?: number; costInr?: number }): Promise<void>;
  deleteUser(userId: string): Promise<void>;
}

let seq = 0;
const uid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

export class MemoryStore implements Store {
  protected newId: () => string = uid;
  users = new Map<string, User>();
  connections = new Map<string, Connection>();
  meetings = new Map<string, Meeting>();
  items = new Map<string, Item>();
  briefs = new Map<string, { date: string; markdown: string; sentAt: string | null; emailId: string | null }>();
  events: Array<Record<string, unknown>> = [];
  /** When each user last looked at Today. Not part of Store: only the local app reads it. */
  looks = new Map<string, LastLook>();

  addUser(u: Partial<User> & { email: string }): User {
    const user: User = { id: this.newId(), name: "", aliases: [], timeZone: "Asia/Kolkata", briefTime: "18:00", createdAt: new Date().toISOString(), ...u };
    this.users.set(user.id, user);
    return user;
  }
  async listUsers() { return [...this.users.values()]; }
  async getUser(id: string) { return this.users.get(id) ?? null; }
  async getConnection(userId: string) { return this.connections.get(userId) ?? null; }
  async saveConnection(c: Connection) { this.connections.set(c.userId, c); }
  async upsertMeeting(m: Omit<Meeting, "id" | "processedAt">) {
    const existing = [...this.meetings.values()].find((x) => x.userId === m.userId && x.providerMeetingId === m.providerMeetingId);
    if (existing) return { meeting: existing, created: false };
    const meeting: Meeting = { ...m, id: this.newId(), processedAt: null };
    this.meetings.set(meeting.id, meeting);
    return { meeting, created: true };
  }
  async listUnprocessedMeetings(userId: string) {
    return [...this.meetings.values()].filter((m) => m.userId === userId && !m.processedAt).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }
  async listMeetingsBetween(userId: string, fromIso: string, toIso: string) {
    return [...this.meetings.values()].filter((m) => m.userId === userId && m.startedAt >= fromIso && m.startedAt < toIso);
  }
  async getMeeting(id: string) { return this.meetings.get(id) ?? null; }
  async commitExtraction({ meetingId, userId, newItems, closes, at }: Parameters<Store["commitExtraction"]>[0]) {
    for (const n of newItems) {
      const item: Item = { ...n, id: this.newId(), userId, status: "open", closedByMeetingId: null, closeQuote: null, createdAt: at, closedAt: null };
      this.items.set(item.id, item);
    }
    for (const c of closes) {
      const it = this.items.get(c.itemId);
      if (it && it.userId === userId && it.status === "open") Object.assign(it, { status: "done", closedByMeetingId: meetingId, closeQuote: c.quote, closedAt: at });
    }
    const m = this.meetings.get(meetingId);
    if (m) m.processedAt = at;
  }
  async listItems(userId: string, filter?: { status?: Item["status"] }) {
    return [...this.items.values()].filter((i) => i.userId === userId && (!filter?.status || i.status === filter.status));
  }
  async setItemStatus(itemId: string, status: Item["status"], at: string) {
    const it = this.items.get(itemId);
    if (it) Object.assign(it, { status, closedAt: status === "open" ? null : at });
  }
  async getBrief(userId: string, date: string) { const b = this.briefs.get(`${userId}:${date}`); return b ? { sentAt: b.sentAt } : null; }
  async saveBrief(userId: string, date: string, markdown: string, sentAt: string | null, emailId: string | null) { this.briefs.set(`${userId}:${date}`, { date, markdown, sentAt, emailId }); }
  async listBriefs(userId: string) { return [...this.briefs.entries()].filter(([k]) => k.startsWith(userId + ":")).map(([, v]) => ({ date: v.date, markdown: v.markdown })); }
  async logEvent(e: Record<string, unknown>) { this.events.push(e); }
  async getLastLook(userId: string): Promise<LastLook | null> { return this.looks.get(userId) ?? null; }
  async saveLastLook(userId: string, look: LastLook): Promise<void> { this.looks.set(userId, look); }
  async deleteUser(userId: string) {
    this.users.delete(userId); this.connections.delete(userId); this.looks.delete(userId);
    for (const [k, m] of this.meetings) if (m.userId === userId) this.meetings.delete(k);
    for (const [k, i] of this.items) if (i.userId === userId) this.items.delete(k);
    for (const k of this.briefs.keys()) if (k.startsWith(userId + ":")) this.briefs.delete(k);
  }
}
