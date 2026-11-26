// The local public API (/api/v1, docs/API.md): a token-protected REST API on this Mac's server.
// - Off until you create a token in Settings (kept in the Keychain; see vault.ts).
// - Refuses any Host but localhost (stops DNS rebinding) and any browser Origin that isn't this
//   Mac's (or one you allowed in Settings), so a web page you visit can't read your brief.
// - Rate limited: 120 requests a minute per token, 20 failed sign-ins a minute in all.
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { DUE_TIME } from "@/lib/capture/parse";
import { isManual } from "@/lib/capture/items";
import { zonedTime } from "@/lib/brief/time";
import { belongsTo, groupNames, listPeople } from "@/lib/people";
import type { Item, Meeting, User } from "@/lib/types";
import type { MemoryStore } from "@/server/store";
import type { IntegrationsStore } from "./config";
import { serializeItem, serializeMeeting } from "./serialize";
import type { Vault } from "./vault";

export const RATE_LIMIT = 120;
export const BAD_AUTH_LIMIT = 20;
const WINDOW_MS = 60_000;

export interface ApiDeps {
  store: MemoryStore;
  integrations: IntegrationsStore;
  vault: Vault;
  appUrl: string;
  now: () => Date;
  /** After a write: let webhooks see it now rather than on the next minute. */
  afterWrite?: () => Promise<void>;
}

// ---------- guard: host, origin, token, rate ----------

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isLocalHost(hostHeader: string | null): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.trim().toLowerCase().replace(/:\d+$/, "");
  return LOCAL_HOSTS.has(host);
}

export function isAllowedOrigin(origin: string, allowed: string[]): boolean {
  if (origin === "tauri://localhost") return true; // the Mac app's own window
  try {
    const u = new URL(origin);
    if ((u.protocol === "http:" || u.protocol === "https:") && LOCAL_HOSTS.has(u.hostname)) return true;
  } catch {
    return false;
  }
  return allowed.some((a) => a.replace(/\/+$/, "").toLowerCase() === origin.toLowerCase());
}

type Window = { start: number; n: number };
const g = globalThis as unknown as { __dbApiRate?: Map<string, Window> };
const windows = () => (g.__dbApiRate ??= new Map());

/** Fixed one-minute windows. Returns the requests left, or -1 with the seconds to wait. */
function take(key: string, limit: number, nowMs: number): { left: number; retryAfter: number } {
  const w = windows().get(key);
  if (!w || nowMs - w.start >= WINDOW_MS) {
    windows().set(key, { start: nowMs, n: 1 });
    return { left: limit - 1, retryAfter: 0 };
  }
  if (w.n >= limit) return { left: -1, retryAfter: Math.ceil((w.start + WINDOW_MS - nowMs) / 1000) };
  w.n++;
  return { left: limit - w.n, retryAfter: 0 };
}

/** Tests: start every limit afresh. */
export function resetRateLimits(): void {
  windows().clear();
}

const digest = (s: string) => createHash("sha256").update(s).digest();
const sameToken = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers } });
}
const fail = (status: number, error: string, headers: Record<string, string> = {}) => json({ error }, status, headers);

function cors(origin: string | null, allowed: boolean): Record<string, string> {
  if (!origin || !allowed) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

type Guarded = { ok: true; user: User; headers: Record<string, string> } | { ok: false; res: Response };

export async function guard(req: Request, deps: ApiDeps): Promise<Guarded> {
  const origin = req.headers.get("origin");
  if (!isLocalHost(req.headers.get("host"))) return { ok: false, res: fail(403, "Only requests to localhost are served.") };
  const allowedOrigins = deps.integrations.read().api.allowedOrigins;
  if (origin && !isAllowedOrigin(origin, allowedOrigins)) return { ok: false, res: fail(403, "This origin isn't allowed. Add it in Settings › Local API.") };
  const h = cors(origin, true);
  const token = await deps.vault.get("LOCAL_API_TOKEN");
  if (!token) return { ok: false, res: fail(403, "The API is off. Create a token in Settings › Local API.", h) };
  const nowMs = deps.now().getTime();
  const given = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1]?.trim() ?? "";
  if (!given || !sameToken(given, token)) {
    const r = take("bad-auth", BAD_AUTH_LIMIT, nowMs);
    if (r.left < 0) return { ok: false, res: fail(429, "Too many failed attempts. Wait a minute.", { ...h, "Retry-After": String(r.retryAfter) }) };
    return { ok: false, res: fail(401, "Missing or wrong token. Send Authorization: Bearer <token>.", { ...h, "WWW-Authenticate": "Bearer" }) };
  }
  const r = take(`token:${digest(token).toString("hex").slice(0, 16)}`, RATE_LIMIT, nowMs);
  const rate = { "X-RateLimit-Limit": String(RATE_LIMIT), "X-RateLimit-Remaining": String(Math.max(0, r.left)) };
  if (r.left < 0) return { ok: false, res: fail(429, "Rate limit: 120 requests a minute.", { ...h, ...rate, "Retry-After": String(r.retryAfter) }) };
  const user = (await deps.store.listUsers())[0];
  if (!user) return { ok: false, res: fail(409, "Set up Daily brief first.", h) };
  return { ok: true, user, headers: { ...h, ...rate } };
}

/** CORS preflight: answered only for allowed origins, without a token (browsers send none). */
export function preflight(req: Request, deps: ApiDeps): Response {
  const origin = req.headers.get("origin");
  if (!isLocalHost(req.headers.get("host"))) return fail(403, "Only requests to localhost are served.");
  if (!origin || !isAllowedOrigin(origin, deps.integrations.read().api.allowedOrigins)) return fail(403, "This origin isn't allowed.");
  return new Response(null, { status: 204, headers: cors(origin, true) });
}

// ---------- handlers ----------

type Ctx = { user: User; params: Record<string, string> };
type Handler = (req: Request, deps: ApiDeps, ctx: Ctx) => Promise<Response>;

/** Wrap a handler with the guard; errors become a 500 without details. */
export function route(handler: Handler) {
  return async (req: Request, deps: ApiDeps, params: Record<string, string> = {}): Promise<Response> => {
    const gd = await guard(req, deps);
    if (!gd.ok) return gd.res;
    try {
      const res = await handler(req, deps, { user: gd.user, params });
      for (const [k, v] of Object.entries(gd.headers)) res.headers.set(k, v);
      return res;
    } catch (e) {
      console.error(`[api] ${req.method} ${new URL(req.url).pathname}: ${e instanceof Error ? e.name : "Error"}`);
      return fail(500, "Something went wrong.", gd.headers);
    }
  };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** An ISO instant, or a YYYY-MM-DD (start of that day in your zone). */
function since(v: string | null, tz: string): string | null {
  if (!v) return null;
  if (DATE.test(v)) return zonedTime(v, "00:00", tz).toISOString();
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}
const limitOf = (v: string | null, def = 100) => Math.max(1, Math.min(500, Number(v) || def));
const offsetOf = (v: string | null) => Math.max(0, Number(v) || 0);

async function loadAll(deps: ApiDeps, user: User) {
  const [items, meetings] = await Promise.all([deps.store.listItems(user.id), deps.store.listMeetingsBetween(user.id, "0000", "9999")]);
  return { items, meetings, byId: new Map(meetings.map((m) => [m.id, m])) };
}

function page<T>(xs: T[], url: URL) {
  const limit = limitOf(url.searchParams.get("limit"));
  const offset = offsetOf(url.searchParams.get("offset"));
  return { total: xs.length, limit, offset, slice: xs.slice(offset, offset + limit) };
}

function personMatch(items: Item[], name: string, self: string[]): (i: Item) => boolean {
  const groups = groupNames(items.map((i) => i.person ?? "").filter(Boolean), self);
  const want = name.trim().toLowerCase();
  const g = groups.find((x) => x.name.toLowerCase() === want || x.keys.some((k) => k.toLowerCase() === want));
  return g ? (i) => belongsTo(g, i.person) : (i) => (i.person ?? "").toLowerCase().includes(want);
}

const newestFirst = (a: Item, b: Item) => b.createdAt.localeCompare(a.createdAt);

export const listItemsRoute = route(async (req, deps, { user }) => {
  const url = new URL(req.url);
  const { items, byId } = await loadAll(deps, user);
  const status = url.searchParams.get("status") ?? "open";
  const kind = url.searchParams.get("kind");
  const person = url.searchParams.get("person");
  const from = since(url.searchParams.get("since"), user.timeZone);
  if (!["open", "done", "wrong", "all"].includes(status)) return fail(400, "status is open, done, wrong or all.");
  if (kind && !["owe", "waiting", "decision"].includes(kind)) return fail(400, "kind is owe, waiting or decision.");
  const match = person ? personMatch(items, person, [user.name, ...user.aliases]) : () => true;
  const xs = items
    .filter((i) => (kind ? i.kind === kind : i.kind !== "decision"))
    .filter((i) => status === "all" || i.status === status)
    .filter((i) => !from || i.createdAt >= from)
    .filter(match)
    .sort(newestFirst);
  const p = page(xs, url);
  return json({ items: p.slice.map((i) => serializeItem(i, byId.get(i.meetingId) ?? null, deps.appUrl)), total: p.total, limit: p.limit, offset: p.offset });
});

export const getItemRoute = route(async (_req, deps, { user, params }) => {
  const { items, byId } = await loadAll(deps, user);
  const i = items.find((x) => x.id === params.id);
  if (!i) return fail(404, "No item with that id.");
  return json({ item: serializeItem(i, byId.get(i.meetingId) ?? null, deps.appUrl) });
});

const dueFields = {
  dueAt: z.string().datetime({ offset: true }).nullable().optional(),
  due: z.string().regex(DATE, "due is YYYY-MM-DD").nullable().optional(),
};
function dueOf(b: { dueAt?: string | null; due?: string | null }, tz: string): string | null | undefined {
  if (b.due !== undefined) return b.due ? zonedTime(b.due, DUE_TIME, tz).toISOString() : null;
  if (b.dueAt !== undefined) return b.dueAt ? new Date(b.dueAt).toISOString() : null;
  return undefined;
}

const createSchema = z.object({
  kind: z.enum(["owe", "waiting"]),
  text: z.string().trim().min(1).max(300),
  person: z.string().trim().max(80).nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
  ...dueFields,
}).strict();

async function body(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}
const invalid = (e: z.ZodError) => fail(400, e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));

export const createItemRoute = route(async (req, deps, { user }) => {
  const p = createSchema.safeParse(await body(req));
  if (!p.success) return invalid(p.error);
  const b = p.data;
  const item = await deps.store.addManualItem(user.id, { kind: b.kind, text: b.text, person: b.person || null, note: b.note || null, dueAt: dueOf(b, user.timeZone) ?? null }, deps.now().toISOString());
  await deps.afterWrite?.();
  return json({ item: serializeItem(item, null, deps.appUrl) }, 201, { Location: `/api/v1/items/${encodeURIComponent(item.id)}` });
});

const patchSchema = z.object({
  status: z.enum(["open", "done", "wrong"]).optional(),
  starred: z.boolean().optional(),
  snoozedUntil: z.string().regex(DATE, "snoozedUntil is YYYY-MM-DD").nullable().optional(),
  text: z.string().trim().min(1).max(300).optional(),
  person: z.string().trim().max(80).nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
  ...dueFields,
}).strict();

export const patchItemRoute = route(async (req, deps, { user, params }) => {
  const p = patchSchema.safeParse(await body(req));
  if (!p.success) return invalid(p.error);
  const b = p.data;
  const items = await deps.store.listItems(user.id);
  const item = items.find((x) => x.id === params.id);
  if (!item) return fail(404, "No item with that id.");
  if ((b.text !== undefined || b.person !== undefined || b.note !== undefined) && !isManual(item)) {
    return fail(400, "text, person and note can only be changed on items you added. Mark it wrong instead.");
  }
  const due = dueOf(b, user.timeZone);
  if (due !== undefined && item.kind === "decision") return fail(400, "Decisions have no due date.");
  const patch: Parameters<MemoryStore["updateItem"]>[1] = {};
  if (b.starred !== undefined) patch.starred = b.starred;
  if (b.snoozedUntil !== undefined) patch.snoozedUntil = b.snoozedUntil;
  if (b.text !== undefined) patch.text = b.text;
  if (b.person !== undefined) patch.person = b.person || null;
  if (b.note !== undefined) patch.note = b.note || null;
  if (due !== undefined) patch.dueAt = due;
  if (Object.keys(patch).length) await deps.store.updateItem(item.id, patch);
  if (b.status && b.status !== item.status) await deps.store.setItemStatus(item.id, b.status, deps.now().toISOString());
  await deps.afterWrite?.();
  const fresh = (await deps.store.listItems(user.id)).find((x) => x.id === item.id)!;
  return json({ item: serializeItem(fresh, (await deps.store.getMeeting(fresh.meetingId)) ?? null, deps.appUrl) });
});

export const listDecisionsRoute = route(async (req, deps, { user }) => {
  const url = new URL(req.url);
  const { items, byId } = await loadAll(deps, user);
  const from = since(url.searchParams.get("since"), user.timeZone);
  const q = url.searchParams.get("q")?.trim().toLowerCase();
  const xs = items
    .filter((i) => i.kind === "decision" && i.status !== "wrong")
    .filter((i) => !from || (byId.get(i.meetingId)?.startedAt ?? i.createdAt) >= from)
    .filter((i) => !q || `${i.text} ${i.quote}`.toLowerCase().includes(q))
    .sort(newestFirst);
  const p = page(xs, url);
  return json({ decisions: p.slice.map((i) => serializeItem(i, byId.get(i.meetingId) ?? null, deps.appUrl)), total: p.total, limit: p.limit, offset: p.offset });
});

export const listPeopleRoute = route(async (req, deps, { user }) => {
  const url = new URL(req.url);
  const { items, meetings } = await loadAll(deps, user);
  const dir = await deps.store.getPeople?.(user.id);
  const people = listPeople({ items, meetings, now: deps.now(), self: [user.name, ...user.aliases], people: dir?.people ?? [] });
  const p = page(people, url);
  return json({
    people: p.slice.map((x) => ({ ...x, url: `${deps.appUrl.replace(/\/+$/, "")}/people/${encodeURIComponent(x.slug)}` })),
    total: p.total, limit: p.limit, offset: p.offset,
  });
});

export const listMeetingsRoute = route(async (req, deps, { user }) => {
  const url = new URL(req.url);
  const from = since(url.searchParams.get("since"), user.timeZone) ?? "0000";
  const to = since(url.searchParams.get("until"), user.timeZone) ?? "9999";
  const meetings: Meeting[] = (await deps.store.listMeetingsBetween(user.id, from, to)).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const items = await deps.store.listItems(user.id);
  const counts = new Map<string, { owe: number; waiting: number; decision: number }>();
  for (const i of items) {
    if (i.status === "wrong") continue;
    const c = counts.get(i.meetingId) ?? { owe: 0, waiting: 0, decision: 0 };
    c[i.kind]++;
    counts.set(i.meetingId, c);
  }
  const p = page(meetings, url);
  return json({ meetings: p.slice.map((m) => serializeMeeting(m, counts.get(m.id) ?? { owe: 0, waiting: 0, decision: 0 })), total: p.total, limit: p.limit, offset: p.offset });
});
