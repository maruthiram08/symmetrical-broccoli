import type { CalendarCache, Connection, Health, Item, LastLook, Meeting, UpcomingCache, User } from "@/lib/types";
import { manualItem, type ManualInput } from "@/lib/capture/items";

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
  /** Upcoming meetings cached by the poll (prep card). Optional: stores without it skip prep. */
  saveUpcoming?(userId: string, cache: UpcomingCache): Promise<void>;
  getUpcoming?(userId: string): Promise<UpcomingCache | null>;
  /** Calendar events and meeting series cached by the poll (src/server/jobs/calendar.ts). Optional. */
  saveCalendar?(userId: string, cache: CalendarCache): Promise<void>;
  getCalendar?(userId: string): Promise<CalendarCache | null>;
  /** Count a failed read of a meeting (it stays unprocessed). Optional: stores without it never give up. */
  recordMeetingFailure?(meetingId: string, failure: string, at: string): Promise<void>;
  /** Retry: forget failed attempts, so set-aside meetings are read again. Returns how many. */
  resetMeetingFailures?(userId: string): Promise<number>;
  /** Mark a meeting as a copy of another (same meeting, another recorder): it is closed without a read. Optional. */
  markMeetingDuplicate?(meetingId: string, duplicateOf: string, at: string): Promise<void>;
  /** What the app last managed to do. Optional: stores without it show no Health section. */
  getHealth?(): Promise<Health>;
  setHealth?(patch: Partial<Health>): Promise<void>;
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
  /** Upcoming meetings per user, from the last poll. */
  upcoming = new Map<string, UpcomingCache>();
  /** "userId:calendarId:startsAt" of meetings already announced with a prep notification. */
  prepNotified = new Set<string>();
  /** Calendar cache per user (events, meeting series). */
  calendar = new Map<string, CalendarCache>();
  health: Health = {};

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
    const existing = [...this.meetings.values()].find((x) => x.userId === m.userId && x.providerMeetingId === m.providerMeetingId && (x.provider ?? "wispr_flow") === (m.provider ?? "wispr_flow"));
    if (existing) return { meeting: existing, created: false };
    const meeting: Meeting = { ...m, id: this.newId(), processedAt: null };
    this.meetings.set(meeting.id, meeting);
    return { meeting, created: true };
  }
  async listUnprocessedMeetings(userId: string) {
    return [...this.meetings.values()].filter((m) => m.userId === userId && !m.processedAt).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }
  async listMeetingsBetween(userId: string, fromIso: string, toIso: string) {
    // A meeting recorded twice counts once: the copy (duplicateOf) is left out.
    return [...this.meetings.values()].filter((m) => m.userId === userId && m.startedAt >= fromIso && m.startedAt < toIso && !m.duplicateOf);
  }
  async markMeetingDuplicate(meetingId: string, duplicateOf: string, at: string) {
    const m = this.meetings.get(meetingId);
    if (m && !m.processedAt) Object.assign(m, { duplicateOf, processedAt: at });
  }
  async getMeeting(id: string) { return this.meetings.get(id) ?? null; }
  async commitExtraction({ meetingId, userId, newItems, closes, at }: Parameters<Store["commitExtraction"]>[0]) {
    for (const n of newItems) {
      const item: Item = { ...n, source: "extracted", id: this.newId(), userId, status: "open", closedByMeetingId: null, closeQuote: null, createdAt: at, closedAt: null };
      this.items.set(item.id, item);
    }
    for (const c of closes) {
      const it = this.items.get(c.itemId);
      if (it && it.userId === userId && it.status === "open") Object.assign(it, { status: "done", closedByMeetingId: meetingId, closeQuote: c.quote, closedAt: at });
    }
    const m = this.meetings.get(meetingId);
    if (m) Object.assign(m, { processedAt: at, failedAttempts: 0, lastFailedAt: null, lastFailure: null });
  }
  async recordMeetingFailure(meetingId: string, failure: string, at: string) {
    const m = this.meetings.get(meetingId);
    if (m && !m.processedAt) Object.assign(m, { failedAttempts: (m.failedAttempts ?? 0) + 1, lastFailedAt: at, lastFailure: failure });
  }
  async resetMeetingFailures(userId: string) {
    let n = 0;
    for (const m of this.meetings.values()) {
      if (m.userId === userId && !m.processedAt && m.failedAttempts) { Object.assign(m, { failedAttempts: 0, lastFailedAt: null, lastFailure: null }); n++; }
    }
    return n;
  }
  async getHealth(): Promise<Health> { return { ...this.health }; }
  async setHealth(patch: Partial<Health>) { this.health = { ...this.health, ...patch }; }
  async listItems(userId: string, filter?: { status?: Item["status"] }) {
    return [...this.items.values()].filter((i) => i.userId === userId && (!filter?.status || i.status === filter.status));
  }
  async setItemStatus(itemId: string, status: Item["status"], at: string) {
    const it = this.items.get(itemId);
    if (it) Object.assign(it, { status, closedAt: status === "open" ? null : at });
  }
  /** Add an item by hand (source "manual"). Not part of Store: only the local app adds them. */
  async addManualItem(userId: string, input: ManualInput, at: string): Promise<Item> {
    const item = manualItem(this.newId(), userId, input, at);
    this.items.set(item.id, item);
    return item;
  }
  /** Change an item's own fields: text, person, due and note (manual items), star and snooze (any). */
  async updateItem(itemId: string, patch: Partial<Pick<Item, "kind" | "text" | "person" | "dueAt" | "note" | "starred" | "snoozedUntil">>): Promise<Item | null> {
    const it = this.items.get(itemId);
    if (!it) return null;
    Object.assign(it, patch);
    return it;
  }
  /** Delete an item outright. The app only offers it for manual items; extracted ones are marked Wrong. */
  async deleteItem(itemId: string): Promise<boolean> { return this.items.delete(itemId); }
  async getBrief(userId: string, date: string) { const b = this.briefs.get(`${userId}:${date}`); return b ? { sentAt: b.sentAt } : null; }
  async saveBrief(userId: string, date: string, markdown: string, sentAt: string | null, emailId: string | null) { this.briefs.set(`${userId}:${date}`, { date, markdown, sentAt, emailId }); }
  async listBriefs(userId: string) { return [...this.briefs.entries()].filter(([k]) => k.startsWith(userId + ":")).map(([, v]) => ({ date: v.date, markdown: v.markdown })); }
  async logEvent(e: Record<string, unknown>) { this.events.push(e); }
  async getLastLook(userId: string): Promise<LastLook | null> { return this.looks.get(userId) ?? null; }
  async saveLastLook(userId: string, look: LastLook): Promise<void> { this.looks.set(userId, look); }
  async saveUpcoming(userId: string, cache: UpcomingCache) { this.upcoming.set(userId, cache); }
  async getUpcoming(userId: string) { return this.upcoming.get(userId) ?? null; }
  async saveCalendar(userId: string, cache: CalendarCache) { this.calendar.set(userId, cache); }
  async getCalendar(userId: string) { return this.calendar.get(userId) ?? null; }
  /** Set (or clear) an open item's due time. Returns false when there is no such item of this user. */
  async setItemDue(userId: string, itemId: string, dueAt: string | null): Promise<boolean> {
    const it = this.items.get(itemId);
    if (!it || it.userId !== userId) return false;
    it.dueAt = dueAt;
    return true;
  }
  /** Record a prep notification. Returns false when this meeting was already announced. */
  async markPrepNotified(key: string): Promise<boolean> {
    if (this.prepNotified.has(key)) return false;
    this.prepNotified.add(key);
    return true;
  }
  async deleteUser(userId: string) {
    this.users.delete(userId); this.connections.delete(userId); this.looks.delete(userId); this.upcoming.delete(userId); this.calendar.delete(userId);
    for (const k of this.prepNotified) if (k.startsWith(userId + ":")) this.prepNotified.delete(k);
    for (const [k, m] of this.meetings) if (m.userId === userId) this.meetings.delete(k);
    for (const [k, i] of this.items) if (i.userId === userId) this.items.delete(k);
    for (const k of this.briefs.keys()) if (k.startsWith(userId + ":")) this.briefs.delete(k);
  }
}
