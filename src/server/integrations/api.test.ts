import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BAD_AUTH_LIMIT, createItemRoute, getItemRoute, isAllowedOrigin, isLocalHost, listDecisionsRoute, listItemsRoute,
  listMeetingsRoute, listPeopleRoute, patchItemRoute, preflight, RATE_LIMIT, resetRateLimits, type ApiDeps,
} from "./api";
import { memVault, NOW, seeded, tmpIntegrations } from "./test-helpers";

const TOKEN = "dbk_test_token_1234567890";
const BASE = "http://localhost:4242";

function req(path: string, init: { method?: string; token?: string | null; origin?: string; host?: string; body?: unknown } = {}): Request {
  const headers: Record<string, string> = { host: init.host ?? "localhost:4242" };
  if (init.token !== null) headers.authorization = `Bearer ${init.token ?? TOKEN}`;
  if (init.origin) headers.origin = init.origin;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`${BASE}${path}`, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body) });
}

async function setup(token: string | null = TOKEN) {
  const s = await seeded();
  const afterWrite = vi.fn(async () => {});
  const deps: ApiDeps = { store: s.store, integrations: tmpIntegrations(), vault: memVault(token ? { LOCAL_API_TOKEN: token } : {}), appUrl: BASE, now: () => NOW, afterWrite };
  return { ...s, deps, afterWrite };
}

beforeEach(() => resetRateLimits());

describe("guard", () => {
  it("knows localhost", () => {
    expect(isLocalHost("localhost:4242")).toBe(true);
    expect(isLocalHost("127.0.0.1")).toBe(true);
    expect(isLocalHost("[::1]:4242")).toBe(true);
    expect(isLocalHost("evil.example.com")).toBe(false);
    expect(isLocalHost("localhost.evil.com")).toBe(false);
    expect(isLocalHost(null)).toBe(false);
    expect(isAllowedOrigin("http://localhost:3000", [])).toBe(true);
    expect(isAllowedOrigin("tauri://localhost", [])).toBe(true);
    expect(isAllowedOrigin("https://evil.example.com", [])).toBe(false);
    expect(isAllowedOrigin("https://mine.example.com", ["https://mine.example.com/"])).toBe(true);
  });

  it("is off until there is a token", async () => {
    const { deps } = await setup(null);
    const r = await listItemsRoute(req("/api/v1/items"), deps);
    expect(r.status).toBe(403);
    expect((await r.json()).error).toMatch(/API is off/);
  });

  it("refuses a missing or wrong token", async () => {
    const { deps } = await setup();
    expect((await listItemsRoute(req("/api/v1/items", { token: null }), deps)).status).toBe(401);
    const r = await listItemsRoute(req("/api/v1/items", { token: "dbk_wrong" }), deps);
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("refuses other hosts (DNS rebinding) and other origins by default", async () => {
    const { deps } = await setup();
    expect((await listItemsRoute(req("/api/v1/items", { host: "attacker.example.com" }), deps)).status).toBe(403);
    const r = await listItemsRoute(req("/api/v1/items", { origin: "https://evil.example.com" }), deps);
    expect(r.status).toBe(403);
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("serves an origin you allowed, with CORS", async () => {
    const { deps } = await setup();
    deps.integrations.update((s) => { s.api.allowedOrigins = ["https://mine.example.com"]; });
    const r = await listItemsRoute(req("/api/v1/items", { origin: "https://mine.example.com" }), deps);
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBe("https://mine.example.com");
    const pre = preflight(new Request(`${BASE}/api/v1/items`, { method: "OPTIONS", headers: { host: "localhost:4242", origin: "https://mine.example.com" } }), deps);
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-headers")).toContain("Authorization");
    expect(preflight(new Request(`${BASE}/api/v1/items`, { method: "OPTIONS", headers: { host: "localhost:4242", origin: "https://evil.example.com" } }), deps).status).toBe(403);
  });

  it("rate limits each token and failed sign-ins", async () => {
    const { deps } = await setup();
    let last: Response | null = null;
    for (let k = 0; k < RATE_LIMIT; k++) last = await listItemsRoute(req("/api/v1/items"), deps);
    expect(last!.status).toBe(200);
    expect(last!.headers.get("x-ratelimit-remaining")).toBe("0");
    const over = await listItemsRoute(req("/api/v1/items"), deps);
    expect(over.status).toBe(429);
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);

    resetRateLimits();
    for (let k = 0; k < BAD_AUTH_LIMIT; k++) expect((await listItemsRoute(req("/api/v1/items", { token: "dbk_nope" }), deps)).status).toBe(401);
    expect((await listItemsRoute(req("/api/v1/items", { token: "dbk_nope" }), deps)).status).toBe(429);
  });
});

describe("endpoints", () => {
  it("GET /items lists open owe and waiting items, with filters", async () => {
    const { deps, waiting } = await setup();
    const r = await listItemsRoute(req("/api/v1/items"), deps);
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.total).toBe(2);
    expect(b.items.map((i: { kind: string }) => i.kind).sort()).toEqual(["owe", "waiting"]);
    expect(b.items[0]).toHaveProperty("meeting.title", "Banner sync");
    const w = await (await listItemsRoute(req("/api/v1/items?kind=waiting&person=nitin"), deps)).json();
    expect(w.items.map((i: { id: string }) => i.id)).toEqual([waiting.id]);
    expect((await listItemsRoute(req("/api/v1/items?status=bogus"), deps)).status).toBe(400);
    expect((await (await listItemsRoute(req("/api/v1/items?status=done"), deps)).json()).total).toBe(0);
    expect((await (await listItemsRoute(req("/api/v1/items?limit=1"), deps)).json()).items).toHaveLength(1);
  });

  it("GET /items/:id, 404 when unknown", async () => {
    const { deps, owe } = await setup();
    const r = await getItemRoute(req(`/api/v1/items/${owe.id}`), deps, { id: owe.id });
    expect((await r.json()).item).toMatchObject({ id: owe.id, text: owe.text, quote: owe.quote, url: `${BASE}/item/${owe.id}` });
    expect((await getItemRoute(req("/api/v1/items/x"), deps, { id: "x" })).status).toBe(404);
  });

  it("POST /items adds your own item", async () => {
    const { deps, store, user, afterWrite } = await setup();
    const r = await createItemRoute(req("/api/v1/items", { method: "POST", body: { kind: "waiting", text: "Tarun owes me the API spec", person: "Tarun", due: "2026-11-28" } }), deps);
    expect(r.status).toBe(201);
    const { item } = await r.json();
    expect(item).toMatchObject({ kind: "waiting", person: "Tarun", source: "manual", status: "open", dueAt: "2026-11-28T12:30:00.000Z" });
    expect(r.headers.get("location")).toBe(`/api/v1/items/${item.id}`);
    expect((await store.listItems(user.id)).some((i) => i.id === item.id)).toBe(true);
    expect(afterWrite).toHaveBeenCalledOnce();
  });

  it("POST /items checks the body", async () => {
    const { deps } = await setup();
    expect((await createItemRoute(req("/api/v1/items", { method: "POST", body: { kind: "decision", text: "x" } }), deps)).status).toBe(400);
    expect((await createItemRoute(req("/api/v1/items", { method: "POST", body: { kind: "owe", text: "" } }), deps)).status).toBe(400);
    expect((await createItemRoute(req("/api/v1/items", { method: "POST", body: { kind: "owe", text: "x", extra: 1 } }), deps)).status).toBe(400);
    expect((await createItemRoute(req("/api/v1/items", { method: "POST", body: "{not json" }), deps)).status).toBe(400);
  });

  it("PATCH /items/:id closes, stars and snoozes; text only on your own", async () => {
    const { deps, owe, afterWrite } = await setup();
    const r = await patchItemRoute(req(`/api/v1/items/${owe.id}`, { method: "PATCH", body: { status: "done", starred: true } }), deps, { id: owe.id });
    expect(r.status).toBe(200);
    expect((await r.json()).item).toMatchObject({ status: "done", starred: true, closedAt: NOW.toISOString() });
    expect(afterWrite).toHaveBeenCalled();
    expect((await patchItemRoute(req(`/api/v1/items/${owe.id}`, { method: "PATCH", body: { text: "new" } }), deps, { id: owe.id })).status).toBe(400);
    expect((await patchItemRoute(req("/api/v1/items/x", { method: "PATCH", body: { status: "done" } }), deps, { id: "x" })).status).toBe(404);
    expect((await patchItemRoute(req(`/api/v1/items/${owe.id}`, { method: "PATCH", body: { status: "finished" } }), deps, { id: owe.id })).status).toBe(400);
  });

  it("GET /decisions, /people and /meetings", async () => {
    const { deps, decision } = await setup();
    const d = await (await listDecisionsRoute(req("/api/v1/decisions?q=banner"), deps)).json();
    expect(d.decisions.map((x: { id: string }) => x.id)).toEqual([decision.id]);
    expect((await (await listDecisionsRoute(req("/api/v1/decisions?since=2026-11-25"), deps)).json()).total).toBe(0);
    const p = await (await listPeopleRoute(req("/api/v1/people"), deps)).json();
    expect(p.people[0]).toMatchObject({ name: "Nitin", youOwe: 1, theyOwe: 1, url: `${BASE}/people/nitin` });
    const m = await (await listMeetingsRoute(req("/api/v1/meetings"), deps)).json();
    expect(m.meetings[0]).toMatchObject({ title: "Banner sync", read: true, items: { owe: 1, waiting: 1, decision: 1 } });
  });
});
