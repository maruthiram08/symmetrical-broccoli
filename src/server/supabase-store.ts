import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { OAuthClientInformationMixed } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Connection, Item, Meeting, User } from "@/lib/types";
import { env } from "@/lib/env";
import type { Store } from "@/server/store";
import type { OAuthClientStore } from "@/server/wispr/oauth";
import { decrypt, encrypt } from "@/server/crypto";

// Row shapes (snake_case, as in supabase/migrations/0001_init.sql).
interface UserRow { id: string; email: string; name: string; aliases: string[] | null; time_zone: string; brief_time: string; created_at: string }
interface ConnectionRow { user_id: string; provider: "wispr_flow"; access_token: string; refresh_token: string; expires_at: string; last_seen_at: string | null; status: Connection["status"]; oauth_client?: { enc: string } | null }
interface MeetingRow { id: string; user_id: string; provider_meeting_id: string; title: string; started_at: string; participants: string[] | null; processed_at: string | null }
interface ItemRow { id: string; user_id: string; kind: Item["kind"]; text: string; person: string | null; quote: string; meeting_id: string; due_at: string | null; status: Item["status"]; closed_by_meeting_id: string | null; close_quote: string | null; created_at: string; closed_at: string | null }

/** Postgres returns "2026-11-25 12:40:36.985+00"; normalise to ISO "…Z" so string comparisons work. */
const iso = (s: string) => new Date(s).toISOString();
const isoOrNull = (s: string | null) => (s ? iso(s) : null);

const toUser = (r: UserRow): User => ({
  id: r.id, email: r.email, name: r.name, aliases: r.aliases ?? [], timeZone: r.time_zone, briefTime: r.brief_time, createdAt: iso(r.created_at),
});
const toMeeting = (r: MeetingRow): Meeting => ({
  id: r.id, userId: r.user_id, providerMeetingId: r.provider_meeting_id, title: r.title, startedAt: iso(r.started_at),
  participants: r.participants ?? [], processedAt: isoOrNull(r.processed_at),
});
const toItem = (r: ItemRow): Item => ({
  id: r.id, userId: r.user_id, kind: r.kind, text: r.text, person: r.person, quote: r.quote, meetingId: r.meeting_id,
  dueAt: isoOrNull(r.due_at), status: r.status, closedByMeetingId: r.closed_by_meeting_id, closeQuote: r.close_quote,
  createdAt: iso(r.created_at), closedAt: isoOrNull(r.closed_at),
});

function check<T>(res: { data: T; error: { message: string; code?: string } | null }, what: string): T {
  if (res.error) throw new Error(`supabase ${what}: ${res.error.message}`);
  return res.data;
}

/**
 * Production Store (service role; RLS is on with no policies, so only the server can read).
 * OAuth tokens and the client registration are encrypted here, at the storage boundary, so the
 * rest of the app only ever sees plaintext in memory.
 */
export class SupabaseStore implements Store, OAuthClientStore {
  private db: SupabaseClient;

  constructor(db?: SupabaseClient, private keyB64?: string) {
    this.db = db ?? createClient(env.supabaseUrl, env.supabaseServiceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  async listUsers(): Promise<User[]> {
    return (check(await this.db.from("users").select("*"), "listUsers") as UserRow[]).map(toUser);
  }

  async getUser(id: string): Promise<User | null> {
    const r = check(await this.db.from("users").select("*").eq("id", id).maybeSingle(), "getUser") as UserRow | null;
    return r ? toUser(r) : null;
  }

  async getConnection(userId: string): Promise<Connection | null> {
    const r = check(
      await this.db.from("connections").select("user_id,provider,access_token,refresh_token,expires_at,last_seen_at,status").eq("user_id", userId).eq("provider", "wispr_flow").maybeSingle(),
      "getConnection",
    ) as ConnectionRow | null;
    if (!r) return null;
    return {
      userId: r.user_id, provider: r.provider,
      accessToken: decrypt(r.access_token, this.keyB64),
      refreshToken: r.refresh_token ? decrypt(r.refresh_token, this.keyB64) : "",
      expiresAt: iso(r.expires_at), lastSeenAt: isoOrNull(r.last_seen_at), status: r.status,
    };
  }

  async saveConnection(c: Connection): Promise<void> {
    // Upsert only these columns, so oauth_client is preserved on update.
    const row: Omit<ConnectionRow, "oauth_client"> = {
      user_id: c.userId, provider: c.provider,
      access_token: encrypt(c.accessToken, this.keyB64),
      refresh_token: c.refreshToken ? encrypt(c.refreshToken, this.keyB64) : "",
      expires_at: c.expiresAt, last_seen_at: c.lastSeenAt, status: c.status,
    };
    check(await this.db.from("connections").upsert(row, { onConflict: "user_id,provider" }), "saveConnection");
  }

  async getOAuthClient(userId: string): Promise<OAuthClientInformationMixed | null> {
    const r = check(
      await this.db.from("connections").select("oauth_client").eq("user_id", userId).eq("provider", "wispr_flow").maybeSingle(),
      "getOAuthClient",
    ) as { oauth_client: { enc?: string } | null } | null;
    const enc = r?.oauth_client?.enc;
    return enc ? (JSON.parse(decrypt(enc, this.keyB64)) as OAuthClientInformationMixed) : null;
  }

  /** Requires the connections row to exist (the OAuth provider saves tokens first). */
  async saveOAuthClient(userId: string, info: OAuthClientInformationMixed): Promise<void> {
    const data = check(
      await this.db.from("connections").update({ oauth_client: { enc: encrypt(JSON.stringify(info), this.keyB64) } }).eq("user_id", userId).eq("provider", "wispr_flow").select("user_id"),
      "saveOAuthClient",
    ) as unknown[];
    if (!data.length) throw new Error("saveOAuthClient: no connection row");
  }

  async upsertMeeting(m: Omit<Meeting, "id" | "processedAt">): Promise<{ meeting: Meeting; created: boolean }> {
    const inserted = check(
      await this.db.from("meetings")
        .upsert(
          { user_id: m.userId, provider_meeting_id: m.providerMeetingId, title: m.title, started_at: m.startedAt, participants: m.participants },
          { onConflict: "user_id,provider_meeting_id", ignoreDuplicates: true },
        )
        .select("*"),
      "upsertMeeting",
    ) as MeetingRow[];
    if (inserted.length) return { meeting: toMeeting(inserted[0]), created: true };
    const existing = check(
      await this.db.from("meetings").select("*").eq("user_id", m.userId).eq("provider_meeting_id", m.providerMeetingId).single(),
      "upsertMeeting/select",
    ) as MeetingRow;
    return { meeting: toMeeting(existing), created: false };
  }

  async listUnprocessedMeetings(userId: string): Promise<Meeting[]> {
    return (check(await this.db.from("meetings").select("*").eq("user_id", userId).is("processed_at", null).order("started_at"), "listUnprocessedMeetings") as MeetingRow[]).map(toMeeting);
  }

  async listMeetingsBetween(userId: string, fromIso: string, toIso: string): Promise<Meeting[]> {
    return (check(
      await this.db.from("meetings").select("*").eq("user_id", userId).gte("started_at", fromIso).lt("started_at", toIso).order("started_at"),
      "listMeetingsBetween",
    ) as MeetingRow[]).map(toMeeting);
  }

  async getMeeting(id: string): Promise<Meeting | null> {
    const r = check(await this.db.from("meetings").select("*").eq("id", id).maybeSingle(), "getMeeting") as MeetingRow | null;
    return r ? toMeeting(r) : null;
  }

  /** One transaction in Postgres: see supabase/migrations/0002_commit_extraction.sql. */
  async commitExtraction(args: Parameters<Store["commitExtraction"]>[0]): Promise<void> {
    check(
      await this.db.rpc("commit_extraction", {
        p_meeting_id: args.meetingId,
        p_user_id: args.userId,
        p_new_items: args.newItems.map((n) => ({ kind: n.kind, text: n.text, person: n.person, quote: n.quote, meeting_id: n.meetingId, due_at: n.dueAt })),
        p_closes: args.closes.map((c) => ({ item_id: c.itemId, quote: c.quote })),
        p_at: args.at,
      }),
      "commitExtraction",
    );
  }

  async listItems(userId: string, filter?: { status?: Item["status"] }): Promise<Item[]> {
    let q = this.db.from("items").select("*").eq("user_id", userId);
    if (filter?.status) q = q.eq("status", filter.status);
    return (check(await q.order("created_at"), "listItems") as ItemRow[]).map(toItem);
  }

  async setItemStatus(itemId: string, status: Item["status"], at: string): Promise<void> {
    check(await this.db.from("items").update({ status, closed_at: status === "open" ? null : at }).eq("id", itemId), "setItemStatus");
  }

  async getBrief(userId: string, date: string): Promise<{ sentAt: string | null } | null> {
    const r = check(await this.db.from("briefs").select("sent_at").eq("user_id", userId).eq("date", date).maybeSingle(), "getBrief") as { sent_at: string | null } | null;
    return r ? { sentAt: isoOrNull(r.sent_at) } : null;
  }

  async saveBrief(userId: string, date: string, markdown: string, sentAt: string | null, emailId: string | null): Promise<void> {
    check(await this.db.from("briefs").upsert({ user_id: userId, date, markdown, sent_at: sentAt, email_id: emailId }, { onConflict: "user_id,date" }), "saveBrief");
  }

  async listBriefs(userId: string): Promise<Array<{ date: string; markdown: string }>> {
    return check(await this.db.from("briefs").select("date,markdown").eq("user_id", userId).order("date", { ascending: false }), "listBriefs") as Array<{ date: string; markdown: string }>;
  }

  async logEvent(e: { userId: string | null; type: string; payload?: unknown; tokensIn?: number; tokensOut?: number; costInr?: number }): Promise<void> {
    check(
      await this.db.from("events").insert({
        user_id: e.userId, type: e.type, payload: e.payload ?? {},
        tokens_in: e.tokensIn ?? null, tokens_out: e.tokensOut ?? null, cost_inr: e.costInr ?? null,
      }),
      "logEvent",
    );
  }

  async deleteUser(userId: string): Promise<void> {
    // Every table references users(id) on delete cascade.
    check(await this.db.from("users").delete().eq("id", userId), "deleteUser");
  }
}
