// The hosted store: the same AppStore the local FileStore implements, on Supabase Postgres.
// Tables are in supabase/migrations. A store is either unscoped (cron: list users, then forUser)
// or scoped to one user: every read and write of a scoped store is limited to that user's rows,
// and passing another user's id throws. Pages only ever get a scoped store (src/server/hosted/app.ts).
import { randomUUID } from "node:crypto";
import type { OAuthClientInformationMixed } from "@modelcontextprotocol/sdk/shared/auth.js";
import { manualItem, type ManualInput } from "@/lib/capture/items";
import type { CalendarCache, Connection, Health, Item, LastLook, Meeting, UpcomingCache, User } from "@/lib/types";
import type { AppStore, RecoveryNotice } from "@/server/app-store";
import { decrypt, encrypt } from "@/server/crypto";
import { applyMarks, marksToKeep, type Mark } from "@/server/local/file-store";
import type { Store } from "@/server/store";
import { isUuid, iso, isoOrNull, tx, type Db } from "./db";

type Row = Record<string, unknown>;

const toUser = (r: Row): User => ({
  id: String(r.id), email: String(r.email), name: String(r.name ?? ""), aliases: (r.aliases as string[] | null) ?? [],
  timeZone: String(r.time_zone), briefTime: String(r.brief_time), includeShared: !!r.include_shared, createdAt: iso(r.created_at),
});

const toMeeting = (r: Row): Meeting => ({
  id: String(r.id), userId: String(r.user_id), providerMeetingId: String(r.provider_meeting_id), title: String(r.title),
  startedAt: iso(r.started_at), participants: (r.participants as string[] | null) ?? [], processedAt: isoOrNull(r.processed_at),
  link: (r.link as string | null) ?? null, shared: !!r.shared || undefined, ownerName: (r.owner_name as string | null) ?? null,
  failedAttempts: Number(r.failed_attempts ?? 0), lastFailedAt: isoOrNull(r.last_failed_at), lastFailure: (r.last_failure as string | null) ?? null,
});

const toItem = (r: Row): Item => ({
  id: String(r.id), userId: String(r.user_id), kind: r.kind as Item["kind"], text: String(r.text), person: (r.person as string | null) ?? null,
  quote: String(r.quote ?? ""), meetingId: String(r.meeting_id), dueAt: isoOrNull(r.due_at), status: r.status as Item["status"],
  closedByMeetingId: (r.closed_by_meeting_id as string | null) ?? null, closeQuote: (r.close_quote as string | null) ?? null,
  createdAt: iso(r.created_at), closedAt: isoOrNull(r.closed_at), source: (r.source as Item["source"]) ?? "extracted",
  note: (r.note as string | null) ?? null, starred: !!r.starred, snoozedUntil: (r.snoozed_until as string | null) ?? null,
});

const ITEM_COLS = "id, user_id, kind, text, person, quote, meeting_id, due_at, status, closed_by_meeting_id, close_quote, created_at, closed_at, source, note, starred, snoozed_until";
const itemValues = (i: Item) => [
  i.id, i.userId, i.kind, i.text, i.person, i.quote ?? "", i.meetingId, i.dueAt, i.status, i.closedByMeetingId, i.closeQuote,
  i.createdAt, i.closedAt, i.source ?? "extracted", i.note ?? null, !!i.starred, i.snoozedUntil ?? null,
];
const placeholders = (n: number, from = 1) => Array.from({ length: n }, (_, k) => `$${k + from}`).join(", ");

/** listMeetingsBetween is called with "0000".."9999" for "all": clamp to dates Postgres accepts. */
function bound(s: string, fallback: string): string {
  const t = Date.parse(s);
  if (Number.isNaN(t) || t < Date.parse("1970-01-01T00:00:00Z") || t > Date.parse("2999-12-31T00:00:00Z")) return fallback;
  return new Date(t).toISOString();
}

/** Delivery settings that only exist when hosted. */
export interface Delivery {
  email: boolean;
  /** Slack incoming-webhook URL (stored encrypted), or null. */
  slackWebhook: string | null;
}

/** The AI extras' state (src/server/local/ai-store.ts), as one JSON document per user. */
export type AiStateDoc = Record<string, unknown>;

export class WrongUserError extends Error {
  constructor() { super("store: this request may not touch another user's data"); this.name = "WrongUserError"; }
}

export class HostedStore implements AppStore {
  readonly path = "Supabase (hosted)";

  constructor(readonly db: Db, readonly scope: string | null = null, private readonly keyB64?: string) {}

  /** The same store, limited to one user's rows. */
  forUser(userId: string): HostedStore {
    if (this.scope && this.scope !== userId) throw new WrongUserError();
    return new HostedStore(this.db, userId, this.keyB64);
  }

  private guard(userId: string): void {
    if (this.scope && userId !== this.scope) throw new WrongUserError();
  }

  /** "and user_id = $n" for scoped stores, with its parameter. */
  private own(n: number): { sql: string; params: unknown[] } {
    return this.scope ? { sql: ` and user_id = $${n}`, params: [this.scope] } : { sql: "", params: [] };
  }

  private enc(s: string) { return encrypt(s, this.keyB64); }
  private dec(s: string) { return decrypt(s, this.keyB64); }

  // ---------- users ----------

  async listUsers(): Promise<User[]> {
    if (this.scope) { const u = await this.getUser(this.scope); return u ? [u] : []; }
    return (await this.db.query("select * from users order by created_at")).rows.map(toUser);
  }

  async getUser(id: string): Promise<User | null> {
    if (!isUuid(id)) return null;
    this.guard(id);
    const r = (await this.db.query("select * from users where id = $1", [id])).rows[0];
    return r ? toUser(r) : null;
  }

  /** First sign-in: the users row (id = the Supabase Auth user id). Returns the user. */
  async ensureUser(id: string, email: string): Promise<User> {
    this.guard(id);
    await this.db.query("insert into users (id, email, referral_code) values ($1, $2, $3) on conflict (id) do nothing", [id, email.toLowerCase(), referralCodeFor(id)]);
    const u = await this.getUser(id);
    if (!u) throw new Error("ensureUser: no row");
    return u;
  }

  async getUserByEmail(email: string): Promise<User | null> {
    const r = (await this.db.query("select * from users where email = $1", [email.trim().toLowerCase()])).rows[0];
    if (!r) return null;
    this.guard(String(r.id));
    return toUser(r);
  }

  async updateUser(id: string, patch: Partial<Omit<User, "id">>): Promise<User | null> {
    if (!isUuid(id)) return null;
    this.guard(id);
    const cols: Record<string, unknown> = {};
    if (patch.email !== undefined) cols.email = patch.email.toLowerCase();
    if (patch.name !== undefined) cols.name = patch.name;
    if (patch.aliases !== undefined) cols.aliases = patch.aliases;
    if (patch.timeZone !== undefined) cols.time_zone = patch.timeZone;
    if (patch.briefTime !== undefined) cols.brief_time = patch.briefTime;
    if (patch.includeShared !== undefined) cols.include_shared = !!patch.includeShared;
    const keys = Object.keys(cols);
    if (keys.length) {
      await this.db.query(`update users set ${keys.map((k, n) => `${k} = $${n + 2}`).join(", ")} where id = $1`, [id, ...keys.map((k) => cols[k])]);
    }
    return this.getUser(id);
  }

  async getDelivery(userId: string): Promise<Delivery> {
    this.guard(userId);
    const r = (await this.db.query("select deliver_email, slack_webhook from users where id = $1", [userId])).rows[0];
    return { email: r ? !!r.deliver_email : true, slackWebhook: r?.slack_webhook ? this.dec(String(r.slack_webhook)) : null };
  }

  async setDelivery(userId: string, d: Delivery): Promise<void> {
    this.guard(userId);
    await this.db.query("update users set deliver_email = $2, slack_webhook = $3 where id = $1", [userId, d.email, d.slackWebhook ? this.enc(d.slackWebhook) : null]);
  }

  async deleteUser(userId: string): Promise<void> {
    this.guard(userId);
    // Every table references users(id) on delete cascade.
    await this.db.query("delete from users where id = $1", [userId]);
  }

  // ---------- Wispr Flow connection (tokens encrypted at rest) ----------

  async getConnection(userId: string): Promise<Connection | null> {
    if (!isUuid(userId)) return null;
    this.guard(userId);
    const r = (await this.db.query("select * from connections where user_id = $1 and provider = 'wispr_flow'", [userId])).rows[0];
    if (!r) return null;
    return {
      userId: String(r.user_id), provider: "wispr_flow",
      accessToken: this.dec(String(r.access_token)), refreshToken: r.refresh_token ? this.dec(String(r.refresh_token)) : "",
      expiresAt: iso(r.expires_at), lastSeenAt: isoOrNull(r.last_seen_at), status: r.status as Connection["status"],
      refreshFailures: Number(r.refresh_failures ?? 0),
    };
  }

  async saveConnection(c: Connection): Promise<void> {
    this.guard(c.userId);
    await this.db.query(
      `insert into connections (user_id, provider, access_token, refresh_token, expires_at, last_seen_at, status, refresh_failures)
       values ($1, 'wispr_flow', $2, $3, $4, $5, $6, $7)
       on conflict (user_id, provider) do update set access_token = excluded.access_token, refresh_token = excluded.refresh_token,
         expires_at = excluded.expires_at, last_seen_at = excluded.last_seen_at, status = excluded.status, refresh_failures = excluded.refresh_failures`,
      [c.userId, this.enc(c.accessToken), c.refreshToken ? this.enc(c.refreshToken) : "", c.expiresAt, c.lastSeenAt, c.status, c.refreshFailures ?? 0],
    );
  }

  async getOAuthClient(userId: string): Promise<OAuthClientInformationMixed | null> {
    this.guard(userId);
    const r = (await this.db.query("select data from oauth_clients where user_id = $1", [userId])).rows[0];
    return r ? (JSON.parse(this.dec(String(r.data))) as OAuthClientInformationMixed) : null;
  }

  async saveOAuthClient(userId: string, info: OAuthClientInformationMixed): Promise<void> {
    this.guard(userId);
    await this.db.query("insert into oauth_clients (user_id, data) values ($1, $2) on conflict (user_id) do update set data = excluded.data", [userId, this.enc(JSON.stringify(info))]);
  }

  // ---------- meetings ----------

  async upsertMeeting(m: Omit<Meeting, "id" | "processedAt">): Promise<{ meeting: Meeting; created: boolean }> {
    this.guard(m.userId);
    const id = randomUUID();
    await this.db.query(
      `insert into meetings (id, user_id, provider_meeting_id, title, started_at, participants, link, shared, owner_name)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict (user_id, provider_meeting_id) do nothing`,
      [id, m.userId, m.providerMeetingId, m.title, m.startedAt, m.participants, m.link ?? null, !!m.shared, m.ownerName ?? null],
    );
    // Whichever row won: ours (created) or the one that was there.
    const r = (await this.db.query("select * from meetings where user_id = $1 and provider_meeting_id = $2", [m.userId, m.providerMeetingId])).rows[0];
    return { meeting: toMeeting(r), created: String(r.id) === id };
  }

  async listUnprocessedMeetings(userId: string): Promise<Meeting[]> {
    this.guard(userId);
    return (await this.db.query("select * from meetings where user_id = $1 and processed_at is null order by started_at", [userId])).rows.map(toMeeting);
  }

  async listMeetingsBetween(userId: string, fromIso: string, toIso: string): Promise<Meeting[]> {
    this.guard(userId);
    const lo = bound(fromIso, "1970-01-01T00:00:00.000Z"), hi = bound(toIso, "2999-12-31T00:00:00.000Z");
    return (await this.db.query("select * from meetings where user_id = $1 and started_at >= $2 and started_at < $3 order by started_at", [userId, lo, hi])).rows.map(toMeeting);
  }

  async getMeeting(id: string): Promise<Meeting | null> {
    if (!isUuid(id)) return null;
    const own = this.own(2);
    const r = (await this.db.query(`select * from meetings where id = $1${own.sql}`, [id, ...own.params])).rows[0];
    return r ? toMeeting(r) : null;
  }

  /** Meetings read since `sinceIso`: the free tier's monthly count. */
  async countProcessedSince(userId: string, sinceIso: string): Promise<number> {
    this.guard(userId);
    const r = (await this.db.query("select count(*)::int as n from meetings where user_id = $1 and processed_at >= $2", [userId, sinceIso])).rows[0];
    return Number(r?.n ?? 0);
  }

  /**
   * New items, closes and "processed" in one transaction, once per meeting (a second commit of the
   * same meeting changes nothing). Marks kept from a re-read go back onto the fresh items.
   */
  async commitExtraction({ meetingId, userId, newItems, closes, at }: Parameters<Store["commitExtraction"]>[0]): Promise<void> {
    this.guard(userId);
    if (!isUuid(meetingId)) throw new Error("commitExtraction: bad meeting id");
    await tx(this.db, async (q) => {
      const m = (await q.query("select processed_at from meetings where id = $1 and user_id = $2 for update", [meetingId, userId])).rows[0];
      if (!m) throw new Error("commitExtraction: meeting not found for user");
      if (m.processed_at) return;
      const fresh: Item[] = newItems.map((n) => ({
        ...n, source: "extracted", id: randomUUID(), userId, status: "open", closedByMeetingId: null, closeQuote: null, createdAt: at, closedAt: null,
      }));
      const marks = (await q.query("select * from marks where user_id = $1 and meeting_id = $2", [userId, meetingId])).rows;
      let used: string[] = [];
      if (marks.length) {
        const byId = new Map(marks.map((r) => [String(r.id), r]));
        const asMarks = marks.map((r) => ({ ...toMark(r), id: String(r.id) }));
        const left = new Set(applyMarks(fresh, asMarks).map((k) => (k as Mark & { id: string }).id));
        used = [...byId.keys()].filter((id) => !left.has(id));
      }
      for (const i of fresh) await q.query(`insert into items (${ITEM_COLS}) values (${placeholders(17)})`, itemValues(i));
      for (const c of closes) {
        if (!isUuid(c.itemId)) continue;
        await q.query(
          "update items set status = 'done', closed_by_meeting_id = $1, close_quote = $2, closed_at = $3 where id = $4 and user_id = $5 and status = 'open'",
          [meetingId, c.quote, at, c.itemId, userId],
        );
      }
      for (const id of used) await q.query("delete from marks where id = $1", [id]);
      await q.query("update meetings set processed_at = $2, failed_attempts = 0, last_failed_at = null, last_failure = null where id = $1", [meetingId, at]);
    });
  }

  async recordMeetingFailure(meetingId: string, failure: string, at: string): Promise<void> {
    if (!isUuid(meetingId)) return;
    const own = this.own(4);
    await this.db.query(
      `update meetings set failed_attempts = failed_attempts + 1, last_failed_at = $2, last_failure = $3 where id = $1 and processed_at is null${own.sql}`,
      [meetingId, at, failure, ...own.params],
    );
  }

  async resetMeetingFailures(userId: string): Promise<number> {
    this.guard(userId);
    const r = await this.db.query(
      "update meetings set failed_attempts = 0, last_failed_at = null, last_failure = null where user_id = $1 and processed_at is null and failed_attempts > 0",
      [userId],
    );
    return r.rowCount ?? 0;
  }

  /** Re-read everything: keep hand-made marks, drop extracted items, mark every meeting unread. */
  async resetExtraction(userId: string): Promise<number> {
    this.guard(userId);
    return tx(this.db, async (q) => {
      const items = (await q.query(`select ${ITEM_COLS} from items where user_id = $1`, [userId])).rows.map(toItem);
      for (const k of marksToKeep(items, userId)) {
        await q.query(
          "insert into marks (id, user_id, meeting_id, kind, text, quote, status, closed_at, starred, snoozed_until) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
          [randomUUID(), userId, k.meetingId, k.kind, k.text, k.quote, k.status, k.closedAt, !!k.starred, k.snoozedUntil ?? null],
        );
      }
      await q.query("delete from items where user_id = $1 and source <> 'manual'", [userId]);
      return (await q.query("update meetings set processed_at = null where user_id = $1", [userId])).rowCount ?? 0;
    });
  }

  // ---------- items ----------

  async listItems(userId: string, filter?: { status?: Item["status"] }): Promise<Item[]> {
    this.guard(userId);
    const r = filter?.status
      ? await this.db.query(`select ${ITEM_COLS} from items where user_id = $1 and status = $2 order by created_at`, [userId, filter.status])
      : await this.db.query(`select ${ITEM_COLS} from items where user_id = $1 order by created_at`, [userId]);
    return r.rows.map(toItem);
  }

  async getItem(itemId: string): Promise<Item | null> {
    if (!isUuid(itemId)) return null;
    const own = this.own(2);
    const r = (await this.db.query(`select ${ITEM_COLS} from items where id = $1${own.sql}`, [itemId, ...own.params])).rows[0];
    return r ? toItem(r) : null;
  }

  async setItemStatus(itemId: string, status: Item["status"], at: string): Promise<void> {
    if (!isUuid(itemId)) return;
    const own = this.own(4);
    await this.db.query(`update items set status = $2, closed_at = $3 where id = $1${own.sql}`, [itemId, status, status === "open" ? null : at, ...own.params]);
  }

  async addManualItem(userId: string, input: ManualInput, at: string): Promise<Item> {
    this.guard(userId);
    const item = manualItem(randomUUID(), userId, input, at);
    await this.db.query(`insert into items (${ITEM_COLS}) values (${placeholders(17)})`, itemValues(item));
    return item;
  }

  async updateItem(itemId: string, patch: Partial<Pick<Item, "kind" | "text" | "person" | "dueAt" | "note" | "starred" | "snoozedUntil">>): Promise<Item | null> {
    const cur = await this.getItem(itemId);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    await this.db.query(
      "update items set kind = $2, text = $3, person = $4, due_at = $5, note = $6, starred = $7, snoozed_until = $8 where id = $1",
      [itemId, next.kind, next.text, next.person, next.dueAt, next.note ?? null, !!next.starred, next.snoozedUntil ?? null],
    );
    return next;
  }

  async deleteItem(itemId: string): Promise<boolean> {
    if (!isUuid(itemId)) return false;
    const own = this.own(2);
    return ((await this.db.query(`delete from items where id = $1${own.sql}`, [itemId, ...own.params])).rowCount ?? 0) > 0;
  }

  async setItemDue(userId: string, itemId: string, dueAt: string | null): Promise<boolean> {
    this.guard(userId);
    if (!isUuid(itemId)) return false;
    return ((await this.db.query("update items set due_at = $3 where id = $1 and user_id = $2", [itemId, userId, dueAt])).rowCount ?? 0) > 0;
  }

  // ---------- briefs and events ----------

  async getBrief(userId: string, date: string): Promise<{ sentAt: string | null } | null> {
    this.guard(userId);
    const r = (await this.db.query("select sent_at from briefs where user_id = $1 and date = $2", [userId, date])).rows[0];
    return r ? { sentAt: isoOrNull(r.sent_at) } : null;
  }

  async saveBrief(userId: string, date: string, markdown: string, sentAt: string | null, emailId: string | null): Promise<void> {
    this.guard(userId);
    await this.db.query(
      `insert into briefs (user_id, date, markdown, sent_at, email_id) values ($1, $2, $3, $4, $5)
       on conflict (user_id, date) do update set markdown = excluded.markdown, sent_at = excluded.sent_at, email_id = excluded.email_id`,
      [userId, date, markdown, sentAt, emailId],
    );
  }

  async listBriefs(userId: string): Promise<Array<{ date: string; markdown: string }>> {
    this.guard(userId);
    return (await this.db.query("select date, markdown from briefs where user_id = $1 order by date", [userId])).rows.map((r) => ({ date: String(r.date), markdown: String(r.markdown) }));
  }

  async logEvent(e: { userId: string | null; type: string; payload?: unknown; tokensIn?: number; tokensOut?: number; costInr?: number }): Promise<void> {
    if (e.userId) this.guard(e.userId);
    const userId = e.userId ?? this.scope;
    await this.db.query(
      "insert into events (user_id, type, payload, tokens_in, tokens_out, cost_inr) values ($1, $2, $3, $4, $5, $6)",
      [userId, e.type, JSON.stringify(e.payload ?? {}), e.tokensIn ?? null, e.tokensOut ?? null, e.costInr ?? null],
    );
  }

  /** Events in the local store's shape ({ userId, type, payload, tokensIn, ..., at }), oldest first. */
  async listEvents(type?: string): Promise<Array<Record<string, unknown>>> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (this.scope) { params.push(this.scope); where.push(`user_id = $${params.length}`); }
    if (type) { params.push(type); where.push(`type = $${params.length}`); }
    const r = await this.db.query(`select * from events${where.length ? ` where ${where.join(" and ")}` : ""} order by id limit 2000`, params);
    return r.rows.map((x) => {
      const e: Record<string, unknown> = { userId: x.user_id ?? null, type: x.type, payload: x.payload, at: iso(x.created_at) };
      if (x.tokens_in != null) e.tokensIn = Number(x.tokens_in);
      if (x.tokens_out != null) e.tokensOut = Number(x.tokens_out);
      if (x.cost_inr != null) e.costInr = Number(x.cost_inr);
      return e;
    });
  }

  // ---------- small per-user state ----------

  async getLastLook(userId: string): Promise<LastLook | null> {
    this.guard(userId);
    const r = (await this.db.query("select * from looks where user_id = $1", [userId])).rows[0];
    return r ? { lastLookedAt: iso(r.last_looked_at), since: isoOrNull(r.since) } : null;
  }

  async saveLastLook(userId: string, look: LastLook): Promise<void> {
    this.guard(userId);
    await this.db.query(
      "insert into looks (user_id, last_looked_at, since) values ($1, $2, $3) on conflict (user_id) do update set last_looked_at = excluded.last_looked_at, since = excluded.since",
      [userId, look.lastLookedAt, look.since],
    );
  }

  private async getCache<T>(userId: string, kind: string): Promise<T | null> {
    this.guard(userId);
    const r = (await this.db.query("select data from caches where user_id = $1 and kind = $2", [userId, kind])).rows[0];
    return r ? (r.data as T) : null;
  }

  private async saveCache(userId: string, kind: string, data: unknown): Promise<void> {
    this.guard(userId);
    await this.db.query(
      "insert into caches (user_id, kind, data, updated_at) values ($1, $2, $3, now()) on conflict (user_id, kind) do update set data = excluded.data, updated_at = excluded.updated_at",
      [userId, kind, JSON.stringify(data)],
    );
  }

  saveUpcoming(userId: string, cache: UpcomingCache) { return this.saveCache(userId, "upcoming", cache); }
  getUpcoming(userId: string) { return this.getCache<UpcomingCache>(userId, "upcoming"); }
  saveCalendar(userId: string, cache: CalendarCache) { return this.saveCache(userId, "calendar", cache); }
  getCalendar(userId: string) { return this.getCache<CalendarCache>(userId, "calendar"); }

  /** Keys look like "<userId>:<what>". Returns false when this one was already recorded. */
  async markPrepNotified(key: string): Promise<boolean> {
    const userId = key.split(":")[0];
    if (!isUuid(userId)) return false;
    this.guard(userId);
    if ((await this.db.query("select 1 from prep_notified where key = $1", [key])).rows.length) return false;
    await this.db.query("insert into prep_notified (key, user_id) values ($1, $2) on conflict (key) do nothing", [key, userId]);
    return true;
  }

  /** Health is per user when hosted; an unscoped store has none. */
  async getHealth(): Promise<Health> {
    if (!this.scope) return {};
    const r = (await this.db.query("select data from health where user_id = $1", [this.scope])).rows[0];
    return { ...((r?.data as Health | undefined) ?? {}) };
  }

  async setHealth(patch: Partial<Health>): Promise<void> {
    if (!this.scope) return;
    const next = { ...(await this.getHealth()), ...patch };
    await this.db.query("insert into health (user_id, data) values ($1, $2) on conflict (user_id) do update set data = excluded.data", [this.scope, JSON.stringify(next)]);
  }

  async getAiState(userId: string): Promise<AiStateDoc | null> {
    this.guard(userId);
    const r = (await this.db.query("select data from ai_state where user_id = $1", [userId])).rows[0];
    return r ? (r.data as AiStateDoc) : null;
  }

  async saveAiState(userId: string, data: AiStateDoc): Promise<void> {
    this.guard(userId);
    await this.db.query(
      "insert into ai_state (user_id, data, updated_at) values ($1, $2, now()) on conflict (user_id) do update set data = excluded.data, updated_at = excluded.updated_at",
      [userId, JSON.stringify(data)],
    );
  }

  /** The local store's backup-restore notice: never happens on Postgres. */
  async getRecovery(): Promise<RecoveryNotice | null> { return null; }
  async dismissRecovery(): Promise<void> {}
}

function toMark(r: Row): Mark {
  return {
    userId: String(r.user_id), meetingId: String(r.meeting_id), kind: r.kind as Item["kind"], text: String(r.text), quote: String(r.quote ?? ""),
    status: r.status as Item["status"], closedAt: isoOrNull(r.closed_at), starred: !!r.starred || undefined, snoozedUntil: (r.snoozed_until as string | null) || undefined,
  };
}

/** A short code friends can type: derived from the user id, so it is stable and unique enough for a few hundred users. */
export function referralCodeFor(userId: string): string {
  return userId.replace(/-/g, "").slice(0, 8).toUpperCase();
}
