// Billing for hosted mode: Razorpay subscriptions (₹500/month), a free tier with a monthly meeting
// limit, and referral codes (a friend gets a free month; you get one when they first pay).
// Everything is off unless BILLING_ENABLED=1, and only Razorpay *test* keys are accepted:
// this app never takes real money. The webhook is verified with RAZORPAY_WEBHOOK_SECRET.
import { createHmac, timingSafeEqual } from "node:crypto";
import { isTestKey, type BillingConfig } from "./config";
import { isUuid, isoOrNull, type Db } from "./db";

type Fetch = typeof fetch;
const DAY_MS = 24 * 60 * 60_000;

// ---------- entitlement ----------

export type Plan = "unlimited" | "paid" | "comp" | "free";

export interface Entitlement {
  plan: Plan;
  /** Meetings that may still be read this month (Infinity unless on the free plan). */
  meetingsLeft: number;
  usedThisMonth: number;
  limit: number | null;
  compUntil: string | null;
  subscription: { id: string; status: string; currentEnd: string | null } | null;
}

/** Statuses during which the subscription counts as paid. "authenticated" = mandate set up, first charge on its way. */
const PAID = new Set(["active", "authenticated", "pending"]);

export const monthStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

export async function getEntitlement(db: Db, userId: string, cfg: BillingConfig, now: Date): Promise<Entitlement> {
  const used = Number((await db.query("select count(*)::int as n from meetings where user_id = $1 and processed_at >= $2", [userId, monthStart(now)])).rows[0]?.n ?? 0);
  const base = { usedThisMonth: used, compUntil: null as string | null, subscription: null as Entitlement["subscription"] };
  if (!cfg.enabled) return { ...base, plan: "unlimited", meetingsLeft: Infinity, limit: null };
  const u = (await db.query("select comp_until from users where id = $1", [userId])).rows[0];
  const s = (await db.query("select subscription_id, status, current_end from subscriptions where user_id = $1", [userId])).rows[0];
  const compUntil = isoOrNull(u?.comp_until ?? null);
  const subscription = s ? { id: String(s.subscription_id), status: String(s.status), currentEnd: isoOrNull(s.current_end) } : null;
  const paid = !!subscription && (PAID.has(subscription.status) || (subscription.status === "cancelled" && !!subscription.currentEnd && Date.parse(subscription.currentEnd) > now.getTime()));
  if (paid) return { ...base, compUntil, subscription, plan: "paid", meetingsLeft: Infinity, limit: null };
  if (compUntil && Date.parse(compUntil) > now.getTime()) return { ...base, compUntil, subscription, plan: "comp", meetingsLeft: Infinity, limit: null };
  return { ...base, compUntil, subscription, plan: "free", meetingsLeft: Math.max(0, cfg.freeMeetingsPerMonth - used), limit: cfg.freeMeetingsPerMonth };
}

// ---------- Razorpay API (test mode only) ----------

export class LiveKeyRefusedError extends Error {
  constructor() { super("Razorpay live keys are refused: use a rzp_test_ key"); this.name = "LiveKeyRefusedError"; }
}

export class Razorpay {
  constructor(private readonly cfg: Pick<BillingConfig, "keyId" | "keySecret">, private readonly f: Fetch = fetch) {
    if (!isTestKey(cfg.keyId)) throw new LiveKeyRefusedError();
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const auth = Buffer.from(`${this.cfg.keyId}:${this.cfg.keySecret}`).toString("base64");
    const res = await this.f(`https://api.razorpay.com/v1${path}`, {
      method,
      headers: { authorization: `Basic ${auth}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as T & { error?: { code?: string } };
    if (!res.ok) throw new Error(`Razorpay ${path} failed: HTTP ${res.status} ${json.error?.code ?? ""}`.trim());
    return json;
  }

  /** A monthly subscription; the user pays on Razorpay's hosted page (short_url). */
  createSubscription(planId: string, userId: string, totalCount = 120) {
    return this.call<{ id: string; status: string; short_url: string }>("POST", "/subscriptions", {
      plan_id: planId, total_count: totalCount, quantity: 1, customer_notify: 1, notes: { user_id: userId },
    });
  }

  cancelSubscription(id: string, atCycleEnd = true) {
    return this.call<{ id: string; status: string }>("POST", `/subscriptions/${encodeURIComponent(id)}/cancel`, { cancel_at_cycle_end: atCycleEnd ? 1 : 0 });
  }
}

/** Start (or reuse) the user's subscription. Returns the payment page to send them to. */
export async function startSubscription(db: Db, userId: string, cfg: BillingConfig, rp: Razorpay): Promise<{ url: string | null; status: string }> {
  if (!cfg.enabled) throw new Error("billing is off");
  const cur = (await db.query("select subscription_id, status from subscriptions where user_id = $1", [userId])).rows[0];
  if (cur && PAID.has(String(cur.status))) return { url: null, status: String(cur.status) };
  const sub = await rp.createSubscription(cfg.planId, userId);
  await db.query(
    `insert into subscriptions (user_id, subscription_id, plan_id, status, updated_at) values ($1, $2, $3, $4, now())
     on conflict (user_id) do update set subscription_id = excluded.subscription_id, plan_id = excluded.plan_id, status = excluded.status, current_end = null, updated_at = now()`,
    [userId, sub.id, cfg.planId, sub.status],
  );
  return { url: sub.short_url, status: sub.status };
}

// ---------- webhook ----------

/** Razorpay signs the raw body: hex HMAC-SHA256 with the webhook secret. */
export function verifyWebhookSignature(rawBody: string, signature: string | null, secret: string): boolean {
  if (!signature || !secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(signature, "utf8"), b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export type WebhookResult = "bad_signature" | "disabled" | "duplicate" | "ignored" | "applied";

interface SubEntity { id?: string; plan_id?: string; status?: string; current_end?: number | null; notes?: { user_id?: string } }

/**
 * Apply one webhook delivery. Signature first; then each event id is applied once (Razorpay
 * retries). Subscription events update the user's subscription; the first charge rewards the
 * friend who referred them.
 */
export async function handleWebhook(
  db: Db, rawBody: string, headers: { signature: string | null; eventId: string | null }, cfg: BillingConfig, now: Date,
): Promise<WebhookResult> {
  if (!cfg.enabled) return "disabled";
  if (!verifyWebhookSignature(rawBody, headers.signature, cfg.webhookSecret)) return "bad_signature";
  let ev: { event?: string; payload?: { subscription?: { entity?: SubEntity } } };
  try { ev = JSON.parse(rawBody); } catch { return "ignored"; }
  const type = String(ev.event ?? "");
  const eventId = headers.eventId ?? createHmac("sha256", "event").update(rawBody).digest("hex");
  if ((await db.query("select 1 from billing_events where id = $1", [eventId])).rows.length) return "duplicate";

  const sub = ev.payload?.subscription?.entity;
  let userId: string | null = null;
  if (type.startsWith("subscription.") && sub?.id) {
    const byId = (await db.query("select user_id from subscriptions where subscription_id = $1", [sub.id])).rows[0];
    userId = byId ? String(byId.user_id) : isUuid(sub.notes?.user_id) ? sub.notes!.user_id! : null;
    if (userId && !(await db.query("select 1 from users where id = $1", [userId])).rows.length) userId = null;
  }
  await db.query("insert into billing_events (id, type, user_id) values ($1, $2, $3) on conflict (id) do nothing", [eventId, type, userId]);
  if (!userId || !sub?.id) return "ignored";

  const currentEnd = sub.current_end ? new Date(sub.current_end * 1000).toISOString() : null;
  await db.query(
    `insert into subscriptions (user_id, subscription_id, plan_id, status, current_end, updated_at) values ($1, $2, $3, $4, $5, now())
     on conflict (user_id) do update set subscription_id = excluded.subscription_id, plan_id = excluded.plan_id, status = excluded.status,
       current_end = excluded.current_end, updated_at = now()`,
    [userId, sub.id, sub.plan_id ?? cfg.planId, sub.status ?? type.slice("subscription.".length), currentEnd],
  );
  if (type === "subscription.charged") await rewardReferrer(db, userId, cfg, now);
  return "applied";
}

// ---------- referrals ----------

export type RedeemResult = "ok" | "disabled" | "unknown_code" | "own_code" | "already_redeemed" | "already_paying";

async function extendComp(db: Db, userId: string, days: number, now: Date): Promise<void> {
  const r = (await db.query("select comp_until from users where id = $1", [userId])).rows[0];
  const from = Math.max(now.getTime(), r?.comp_until ? Date.parse(isoOrNull(r.comp_until)!) : 0);
  await db.query("update users set comp_until = $2 where id = $1", [userId, new Date(from + days * DAY_MS).toISOString()]);
}

/** A friend types your code: they get a free month (once per account, and not once they pay). */
export async function redeemReferral(db: Db, userId: string, rawCode: string, cfg: BillingConfig, now: Date): Promise<RedeemResult> {
  if (!cfg.enabled) return "disabled";
  const code = rawCode.trim().toUpperCase();
  if (!/^[0-9A-Z]{4,16}$/.test(code)) return "unknown_code";
  const owner = (await db.query("select id from users where referral_code = $1", [code])).rows[0];
  if (!owner) return "unknown_code";
  if (String(owner.id) === userId) return "own_code";
  if ((await db.query("select 1 from referrals where referred_id = $1", [userId])).rows.length) return "already_redeemed";
  const s = (await db.query("select status from subscriptions where user_id = $1", [userId])).rows[0];
  if (s && PAID.has(String(s.status))) return "already_paying";
  await db.query("insert into referrals (referred_id, referrer_id, code, redeemed_at) values ($1, $2, $3, $4)", [userId, owner.id, code, now.toISOString()]);
  await extendComp(db, userId, cfg.referralFreeDays, now);
  return "ok";
}

/** The referrer's free month, once, when the friend they brought in is first charged. */
async function rewardReferrer(db: Db, referredId: string, cfg: BillingConfig, now: Date): Promise<void> {
  const r = (await db.query("select referrer_id from referrals where referred_id = $1 and referrer_rewarded_at is null", [referredId])).rows[0];
  if (!r) return;
  await db.query("update referrals set referrer_rewarded_at = $2 where referred_id = $1", [referredId, now.toISOString()]);
  await extendComp(db, String(r.referrer_id), cfg.referralFreeDays, now);
}

export async function referralCode(db: Db, userId: string): Promise<string | null> {
  const r = (await db.query("select referral_code from users where id = $1", [userId])).rows[0];
  return r?.referral_code ? String(r.referral_code) : null;
}
