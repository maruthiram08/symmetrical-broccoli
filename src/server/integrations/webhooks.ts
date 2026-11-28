// Outgoing webhooks: item.created, item.closed and decision.made, POSTed as signed JSON to the URLs
// set in Settings. Off by default. Changes are found by comparing items with the last statuses seen,
// so every path (a meeting read, a button, the MCP server, the API, a closed ticket) fires once.
// Failed deliveries are retried with backoff and kept in integrations.json, so a restart loses none.
import { createHmac, randomUUID } from "node:crypto";
import type { Item, Meeting } from "@/lib/types";
import type { MemoryStore } from "@/server/store";
import type { Delivery, DeliveryLog, IntegrationsStore, WebhookEvent } from "./config";
import type { Fetch } from "./http";
import { serializeItem } from "./serialize";
import type { Vault } from "./vault";

/** Wait before attempt n+1 (after the first try fails): 30 s, 2 min, 10 min, 1 h, 6 h. Then it gives up. */
export const BACKOFF_MS = [30_000, 2 * 60_000, 10 * 60_000, 60 * 60_000, 6 * 60 * 60_000];
export const MAX_ATTEMPTS = BACKOFF_MS.length + 1;
const TIMEOUT_MS = 10_000;
export const SIGNATURE_HEADER = "X-Daily-Brief-Signature";

export interface WebhookDeps {
  store: MemoryStore;
  integrations: IntegrationsStore;
  vault: Vault;
  fetch: Fetch;
  appUrl: string;
  now: () => Date;
}

/** "t=<unix seconds>,v1=<hex HMAC-SHA256 of `${t}.${body}`>". Verify it the same way (docs/API.md). */
export function sign(secret: string, body: string, unixSeconds: number): string {
  const mac = createHmac("sha256", secret).update(`${unixSeconds}.${body}`).digest("hex");
  return `t=${unixSeconds},v1=${mac}`;
}

/** Only http(s) URLs with a host, no credentials in them. */
export function validWebhookUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (!u.hostname || u.username || u.password) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** What changed since the last look. New decisions are decision.made; other new items are item.created. */
export function diffItems(items: Item[], seen: Record<string, string>): Array<{ event: WebhookEvent; item: Item }> {
  const out: Array<{ event: WebhookEvent; item: Item }> = [];
  for (const i of items) {
    const was = seen[i.id];
    if (was === undefined) out.push({ event: i.kind === "decision" ? "decision.made" : "item.created", item: i });
    else if (was === "open" && i.status !== "open" && i.kind !== "decision") out.push({ event: "item.closed", item: i });
  }
  return out;
}

function payload(event: WebhookEvent, item: Item, meeting: Meeting | null, appUrl: string, at: string) {
  return { id: `evt_${randomUUID()}`, type: event, createdAt: at, data: { item: serializeItem(item, meeting, appUrl) } };
}

/**
 * Find changes and queue a delivery per URL. The first run (or the first after switching webhooks
 * on) only records what is there, so history never floods your endpoint. Returns how many were queued.
 */
export async function queueChanges(deps: WebhookDeps): Promise<number> {
  const st = deps.integrations.read();
  if (!st.webhooks.enabled) {
    // Off: nothing is watched. Switching on again starts from what is there then.
    if (st.primed) deps.integrations.update((s) => { s.primed = false; s.seen = {}; });
    return 0;
  }
  const users = await deps.store.listUsers();
  const items = (await Promise.all(users.map((u) => deps.store.listItems(u.id)))).flat();
  const seen = Object.fromEntries(items.map((i) => [i.id, i.status]));
  if (!st.primed) {
    deps.integrations.update((s) => { s.seen = seen; s.primed = true; });
    return 0;
  }
  const same = Object.keys(seen).length === Object.keys(st.seen).length && Object.entries(seen).every(([k, v]) => st.seen[k] === v);
  if (same) return 0;
  const changes = diffItems(items, st.seen).filter((c) => st.webhooks.events.includes(c.event));
  const at = deps.now().toISOString();
  const queued: Delivery[] = [];
  for (const c of changes) {
    const meeting = c.item.meetingId ? await deps.store.getMeeting(c.item.meetingId) : null;
    const body = JSON.stringify(payload(c.event, c.item, meeting, deps.appUrl, at));
    for (const url of st.webhooks.urls) queued.push({ id: `dlv_${randomUUID()}`, url, event: c.event, body, attempts: 0, nextAt: at, createdAt: at });
  }
  deps.integrations.update((s) => { s.seen = seen; s.outbox.push(...queued); });
  return queued.length;
}

/** Send one delivery. True on a 2xx answer. */
async function post(deps: WebhookDeps, secret: string, d: Delivery, event: string = d.event): Promise<{ ok: boolean; status: number | null }> {
  const t = Math.floor(deps.now().getTime() / 1000);
  try {
    const res = await deps.fetch(d.url, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "DailyBrief-Webhooks/1",
        "X-Daily-Brief-Event": event,
        "X-Daily-Brief-Delivery": d.id,
        [SIGNATURE_HEADER]: sign(secret, d.body, t),
      },
      body: d.body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await res.body?.cancel().catch(() => undefined);
    return { ok: res.status >= 200 && res.status < 300, status: res.status };
  } catch {
    return { ok: false, status: null };
  }
}

/** Send every delivery that is due. Failures wait (BACKOFF_MS) and are dropped after MAX_ATTEMPTS. */
export async function deliverDue(deps: WebhookDeps): Promise<{ delivered: number; retrying: number; failed: number }> {
  const out = { delivered: 0, retrying: 0, failed: 0 };
  const st = deps.integrations.read();
  const nowMs = deps.now().getTime();
  const due = st.outbox.filter((d) => Date.parse(d.nextAt) <= nowMs);
  if (!due.length) return out;
  const secret = await deps.vault.get("WEBHOOK_SECRET");
  if (!secret) return out; // nothing is sent unsigned; Settings asks for a secret first
  const done = new Set<string>();
  const later = new Map<string, Delivery>();
  const logs: DeliveryLog[] = [];
  for (const d of due) {
    // Deliveries to a URL that was removed are dropped.
    if (!st.webhooks.urls.includes(d.url)) { done.add(d.id); continue; }
    const r = await post(deps, secret, d);
    const attempts = d.attempts + 1;
    const at = deps.now().toISOString();
    if (r.ok) {
      done.add(d.id);
      out.delivered++;
      logs.push({ id: d.id, url: d.url, event: d.event, at, outcome: "delivered", status: r.status, attempts });
    } else if (attempts >= MAX_ATTEMPTS) {
      done.add(d.id);
      out.failed++;
      logs.push({ id: d.id, url: d.url, event: d.event, at, outcome: "failed", status: r.status, attempts });
    } else {
      later.set(d.id, { ...d, attempts, nextAt: new Date(nowMs + BACKOFF_MS[attempts - 1]).toISOString() });
      out.retrying++;
      logs.push({ id: d.id, url: d.url, event: d.event, at, outcome: "retrying", status: r.status, attempts });
    }
  }
  deps.integrations.update((s) => {
    s.outbox = s.outbox.filter((d) => !done.has(d.id)).map((d) => later.get(d.id) ?? d);
    s.recent.push(...logs);
  });
  return out;
}

/** Queue changes, then send what's due. Safe to call often (every minute, after an API write). */
export async function runWebhooks(deps: WebhookDeps): Promise<void> {
  await queueChanges(deps);
  if (deps.integrations.read().webhooks.enabled) await deliverDue(deps);
}

/** Settings' "Send a test": one signed ping to every URL now, outside the queue. */
export async function sendTest(deps: WebhookDeps): Promise<Array<{ url: string; status: number | null; ok: boolean }>> {
  const st = deps.integrations.read();
  const secret = await deps.vault.get("WEBHOOK_SECRET");
  if (!secret) return st.webhooks.urls.map((url) => ({ url, status: null, ok: false }));
  const at = deps.now().toISOString();
  const body = JSON.stringify({ id: `evt_${randomUUID()}`, type: "ping", createdAt: at, data: {} });
  const out = [];
  for (const url of st.webhooks.urls) {
    const r = await post(deps, secret, { id: `dlv_${randomUUID()}`, url, event: "item.created", body, attempts: 0, nextAt: at, createdAt: at }, "ping");
    out.push({ url, ...r });
  }
  return out;
}
