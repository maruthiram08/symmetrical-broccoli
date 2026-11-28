import { createHmac, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { billingConfig, type BillingConfig } from "./config";
import type { Db } from "./db";
import { getEntitlement, handleWebhook, LiveKeyRefusedError, Razorpay, redeemReferral, referralCode, startSubscription, verifyWebhookSignature } from "./billing";
import { HostedStore } from "./store";
import { memDb, TEST_KEY } from "./testing";

const NOW = new Date("2026-11-20T10:00:00.000Z");
const SECRET = "whsec_test_123";
const cfg: BillingConfig = { ...billingConfig({}), enabled: true, keyId: "rzp_test_abc", keySecret: "s", webhookSecret: SECRET, planId: "plan_test" };
let db: Db, store: HostedStore, a: string, b: string;

beforeEach(async () => {
  db = memDb().db;
  store = new HostedStore(db, null, TEST_KEY);
  a = randomUUID(); b = randomUUID();
  await store.ensureUser(a, "a@x.com");
  await store.ensureUser(b, "b@x.com");
});

async function readMeetings(userId: string, n: number, at = NOW.toISOString()) {
  for (let k = 0; k < n; k++) {
    const { meeting } = await store.upsertMeeting({ userId, providerMeetingId: `p${k}`, title: "t", startedAt: at, participants: [] });
    await store.commitExtraction({ meetingId: meeting.id, userId, at, newItems: [], closes: [] });
  }
}

const sign = (body: string, secret = SECRET) => createHmac("sha256", secret).update(body).digest("hex");
const event = (type: string, sub: Record<string, unknown>) => JSON.stringify({ event: type, payload: { subscription: { entity: { id: "sub_1", plan_id: "plan_test", ...sub } } } });

describe("entitlement", () => {
  it("is unlimited while billing is off", async () => {
    await readMeetings(a, 3);
    expect(await getEntitlement(db, a, { ...cfg, enabled: false }, NOW)).toMatchObject({ plan: "unlimited", meetingsLeft: Infinity, usedThisMonth: 3 });
  });

  it("free plan counts this month's reads against the limit", async () => {
    await readMeetings(a, 3);
    expect(await getEntitlement(db, a, { ...cfg, freeMeetingsPerMonth: 5 }, NOW)).toMatchObject({ plan: "free", meetingsLeft: 2, limit: 5 });
    expect(await getEntitlement(db, a, { ...cfg, freeMeetingsPerMonth: 2 }, NOW)).toMatchObject({ meetingsLeft: 0 });
    expect(await getEntitlement(db, a, { ...cfg, freeMeetingsPerMonth: 5 }, new Date("2026-12-01T00:00:00Z"))).toMatchObject({ meetingsLeft: 5 });
  });
});

describe("Razorpay client", () => {
  it("refuses live keys", () => {
    expect(() => new Razorpay({ keyId: "rzp_live_abc", keySecret: "x" })).toThrow(LiveKeyRefusedError);
  });

  it("creates a subscription and remembers it", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ id: "sub_1", status: "created", short_url: "https://rzp.io/i/x" }), { status: 200 }));
    const rp = new Razorpay(cfg, f as unknown as typeof fetch);
    expect(await startSubscription(db, a, cfg, rp)).toEqual({ url: "https://rzp.io/i/x", status: "created" });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.razorpay.com/v1/subscriptions");
    expect(JSON.parse(String(init.body))).toMatchObject({ plan_id: "plan_test", notes: { user_id: a } });
    expect((init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from("rzp_test_abc:s").toString("base64")}`);
    expect((await db.query("select status from subscriptions where user_id = $1", [a])).rows[0].status).toBe("created");
  });
});

describe("webhook", () => {
  it("rejects a bad or missing signature", async () => {
    const body = event("subscription.activated", { status: "active", notes: { user_id: a } });
    expect(verifyWebhookSignature(body, sign(body), SECRET)).toBe(true);
    expect(await handleWebhook(db, body, { signature: sign(body, "wrong"), eventId: "e1" }, cfg, NOW)).toBe("bad_signature");
    expect(await handleWebhook(db, body, { signature: null, eventId: "e1" }, cfg, NOW)).toBe("bad_signature");
    expect((await getEntitlement(db, a, cfg, NOW)).plan).toBe("free");
  });

  it("activates the subscription once per event id", async () => {
    const body = event("subscription.activated", { status: "active", current_end: Date.parse("2026-12-20T00:00:00Z") / 1000, notes: { user_id: a } });
    expect(await handleWebhook(db, body, { signature: sign(body), eventId: "e1" }, cfg, NOW)).toBe("applied");
    expect(await handleWebhook(db, body, { signature: sign(body), eventId: "e1" }, cfg, NOW)).toBe("duplicate");
    expect(await getEntitlement(db, a, cfg, NOW)).toMatchObject({ plan: "paid", meetingsLeft: Infinity, subscription: { id: "sub_1", status: "active", currentEnd: "2026-12-20T00:00:00.000Z" } });
    const halted = event("subscription.halted", { status: "halted" });
    expect(await handleWebhook(db, halted, { signature: sign(halted), eventId: "e2" }, cfg, NOW)).toBe("applied");
    expect((await getEntitlement(db, a, cfg, NOW)).plan).toBe("free");
  });

  it("ignores events for unknown users and is off when billing is off", async () => {
    const body = event("subscription.activated", { status: "active", notes: { user_id: randomUUID() } });
    expect(await handleWebhook(db, body, { signature: sign(body), eventId: "e9" }, cfg, NOW)).toBe("ignored");
    expect(await handleWebhook(db, body, { signature: sign(body), eventId: "e10" }, { ...cfg, enabled: false }, NOW)).toBe("disabled");
  });
});

describe("referrals", () => {
  it("gives the friend a free month, and the referrer one on the friend's first charge", async () => {
    const code = (await referralCode(db, a))!;
    expect(await redeemReferral(db, b, code.toLowerCase(), cfg, NOW)).toBe("ok");
    expect(await redeemReferral(db, b, code, cfg, NOW)).toBe("already_redeemed");
    const eb = await getEntitlement(db, b, cfg, NOW);
    expect(eb).toMatchObject({ plan: "comp", compUntil: "2026-12-20T10:00:00.000Z" });
    expect((await getEntitlement(db, a, cfg, NOW)).plan).toBe("free");
    const charged = JSON.stringify({ event: "subscription.charged", payload: { subscription: { entity: { id: "sub_b", status: "active", notes: { user_id: b } } } } });
    expect(await handleWebhook(db, charged, { signature: sign(charged), eventId: "c1" }, cfg, NOW)).toBe("applied");
    expect(await getEntitlement(db, a, cfg, NOW)).toMatchObject({ plan: "comp", compUntil: "2026-12-20T10:00:00.000Z" });
    const again = JSON.stringify({ event: "subscription.charged", payload: { subscription: { entity: { id: "sub_b", status: "active" } } } });
    await handleWebhook(db, again, { signature: sign(again), eventId: "c2" }, cfg, NOW);
    expect((await getEntitlement(db, a, cfg, NOW)).compUntil).toBe("2026-12-20T10:00:00.000Z");
  });

  it("refuses your own code and unknown codes", async () => {
    expect(await redeemReferral(db, a, (await referralCode(db, a))!, cfg, NOW)).toBe("own_code");
    expect(await redeemReferral(db, a, "NOPE1234", cfg, NOW)).toBe("unknown_code");
    expect(await redeemReferral(db, a, "x'; drop", cfg, NOW)).toBe("unknown_code");
  });
});
