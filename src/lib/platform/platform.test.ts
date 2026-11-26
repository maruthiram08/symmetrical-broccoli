import { describe, expect, it, vi } from "vitest";
import { MemoryStore } from "@/server/store";
import { appManifest } from "./manifest";
import { swMain, swSource, SW_CONFIG, type SwConfig } from "./sw";
import { trayTitle, widgetSummary, widgetText } from "./widget";

describe("widget", () => {
  it("says what you owe in one line", () => {
    expect(widgetText(3, 1)).toBe("3 you owe today · 1 overdue");
    expect(widgetText(2, 0)).toBe("2 you owe today");
    expect(widgetText(0, 0)).toBe("Nothing owed today");
    expect(trayTitle({ owe: 3 })).toBe("3");
    expect(trayTitle({ owe: 0 })).toBe("");
  });

  it("counts the same things Today shows", async () => {
    const store = new MemoryStore();
    const user = store.addUser({ email: "you@this-mac", name: "Maruthi", timeZone: "Asia/Kolkata" });
    const now = new Date("2026-11-26T08:00:00.000Z");
    const { meeting } = await store.upsertMeeting({ userId: user.id, providerMeetingId: "m1", title: "Sync", startedAt: "2026-11-26T05:00:00.000Z", participants: [] });
    await store.commitExtraction({
      meetingId: meeting.id, userId: user.id, at: now.toISOString(), closes: [],
      newItems: [
        { kind: "owe", text: "Send the deck", person: "Nitin", quote: "q", meetingId: meeting.id, dueAt: "2026-11-26T06:00:00.000Z" },
        { kind: "owe", text: "Book the venue", person: null, quote: "q", meetingId: meeting.id, dueAt: null },
        { kind: "owe", text: "Review the spec", person: null, quote: "q", meetingId: meeting.id, dueAt: "2026-11-26T12:00:00.000Z" },
        { kind: "waiting", text: "API spec", person: "Tarun", quote: "q", meetingId: meeting.id, dueAt: null },
      ],
    });
    const s = await widgetSummary(store, user, now);
    expect(s).toMatchObject({ text: "3 you owe today · 1 overdue", owe: 3, overdue: 1, waiting: 1, next: "Send the deck", date: "2026-11-26" });
  });
});

describe("manifest", () => {
  it("is installable: standalone, start URL and 192/512 icons including maskable", () => {
    const m = appManifest();
    expect(m).toMatchObject({ display: "standalone", start_url: "/", scope: "/" });
    const sizes = (m.icons ?? []).map((i) => `${i.sizes}:${i.purpose}`);
    expect(sizes).toEqual(expect.arrayContaining(["512x512:any", "192x192:maskable", "512x512:maskable"]));
  });
});

// ---------- service worker, against a fake browser ----------

type Handler = (e: unknown) => void;
class FakeCache {
  m = new Map<string, Response>();
  key = (r: string | Request) => (typeof r === "string" ? new URL(r, "http://mac.local").pathname : new URL(r.url).pathname);
  async add(u: string) { const r = await globalThis.fetch(new Request(new URL(u, "http://mac.local"))); if (!r.ok) throw new Error("bad"); this.m.set(this.key(u), r); }
  has(k: string) { return this.m.has(k); }
  async put(k: string | Request, r: Response) { this.m.set(this.key(k), r); }
  async match(k: string | Request) { const r = this.m.get(this.key(k)); return r ? r.clone() : undefined; }
}

function fakeSelf() {
  const caches = new Map<string, FakeCache>();
  const handlers: Record<string, Handler> = {};
  const self = {
    location: { origin: "http://mac.local" },
    caches: {
      open: async (n: string) => { if (!caches.has(n)) caches.set(n, new FakeCache()); return caches.get(n)!; },
      keys: async () => [...caches.keys()],
      delete: async (n: string) => caches.delete(n),
    },
    clients: { claim: vi.fn(async () => undefined) },
    skipWaiting: vi.fn(async () => undefined),
    addEventListener: (t: string, h: Handler) => { handlers[t] = h; },
  };
  return { self, caches, handlers };
}

async function dispatch(handlers: Record<string, Handler>, type: string, request?: Request & { mode?: string }) {
  let waited: Promise<unknown> | undefined;
  let responded: Promise<Response> | undefined;
  handlers[type]({ request, waitUntil: (p: Promise<unknown>) => (waited = p), respondWith: (p: Promise<Response>) => (responded = p) });
  await waited;
  return responded ? await responded : undefined;
}

const pathOf = (r: Request | string) => new URL(typeof r === "string" ? r : r.url, "http://mac.local").pathname;

function navigate(path: string): Request {
  const r = new Request(`http://mac.local${path}`);
  Object.defineProperty(r, "mode", { value: "navigate" });
  return r;
}

describe("service worker", () => {
  const cfg: SwConfig = { ...SW_CONFIG, version: "t1", timeoutMs: 50 };

  it("pre-caches Today, All open and People, with their scripts and styles, at install", async () => {
    const f = fakeSelf();
    vi.stubGlobal("fetch", vi.fn(async (r: Request | string) =>
      new Response(`<script src="/_next/static/chunks/${pathOf(r).slice(1) || "home"}.js"></script><link href="/_next/static/css/a.css">`)));
    swMain(f.self, cfg);
    await dispatch(f.handlers, "install");
    expect([...f.caches.get("db-pages-t1")!.m.keys()].sort()).toEqual(["/", "/open", "/people"]);
    expect([...f.caches.get("db-static-t1")!.m.keys()].sort()).toEqual(["/_next/static/chunks/home.js", "/_next/static/chunks/open.js", "/_next/static/chunks/people.js", "/_next/static/css/a.css"]);
    vi.unstubAllGlobals();
  });

  it("serves the saved Today when the network is gone, and the offline page for pages never saved", async () => {
    const f = fakeSelf();
    let online = true;
    vi.stubGlobal("fetch", vi.fn(async (r: Request | string) => {
      if (!online) throw new TypeError("Failed to fetch");
      return new Response(`fresh ${pathOf(r)}`);
    }));
    swMain(f.self, cfg);
    await dispatch(f.handlers, "install");
    expect(await (await dispatch(f.handlers, "fetch", navigate("/people/nitin")))!.text()).toBe("fresh /people/nitin");
    online = false;
    expect(await (await dispatch(f.handlers, "fetch", navigate("/?undo=1")))!.text()).toBe("fresh /");
    expect(await (await dispatch(f.handlers, "fetch", navigate("/people/nitin")))!.text()).toBe("fresh /people/nitin");
    const off = (await dispatch(f.handlers, "fetch", navigate("/ask")))!;
    expect(off.status).toBe(503);
    expect(await off.text()).toContain("You're offline");
    vi.unstubAllGlobals();
  });

  it("falls back to the saved copy when the Mac is slow", async () => {
    const f = fakeSelf();
    vi.stubGlobal("fetch", vi.fn(async (r: Request | string) => new Response(`v1 ${pathOf(r)}`)));
    swMain(f.self, cfg);
    await dispatch(f.handlers, "install");
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((res) => setTimeout(() => res(new Response("v2")), 200))));
    expect(await (await dispatch(f.handlers, "fetch", navigate("/open")))!.text()).toBe("v1 /open");
    vi.unstubAllGlobals();
  });

  it("never touches POSTs, API calls or RSC requests, and caches built assets", async () => {
    const f = fakeSelf();
    swMain(f.self, cfg);
    expect(await dispatch(f.handlers, "fetch", new Request("http://mac.local/", { method: "POST", body: "x" }))).toBeUndefined();
    expect(await dispatch(f.handlers, "fetch", new Request("http://mac.local/api/widget"))).toBeUndefined();
    expect(await dispatch(f.handlers, "fetch", new Request("http://mac.local/open", { headers: { RSC: "1" } }))).toBeUndefined();
    expect(await dispatch(f.handlers, "fetch", new Request("http://other.example/x.js"))).toBeUndefined();
    const fetchMock = vi.fn(async () => new Response("js"));
    vi.stubGlobal("fetch", fetchMock);
    await dispatch(f.handlers, "fetch", new Request("http://mac.local/_next/static/chunks/a.js"));
    await dispatch(f.handlers, "fetch", new Request("http://mac.local/_next/static/chunks/a.js"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("drops caches from older versions on activate", async () => {
    const f = fakeSelf();
    await f.self.caches.open("db-pages-old");
    await f.self.caches.open("someone-else");
    swMain(f.self, cfg);
    await dispatch(f.handlers, "activate");
    expect([...f.caches.keys()]).toEqual(["someone-else"]);
  });

  it("has an offline page that needs nothing from the network", () => {
    expect(SW_CONFIG.offlineHtml).not.toMatch(/<script|<link|src=/);
    expect(SW_CONFIG.offlineHtml).toContain('href="/open"');
  });

  it("serves as one self-contained script", () => {
    const src = swSource("9");
    expect(src).toContain('"version":"9"');
    // Runs with nothing but a fake `self` in scope.
    const f = fakeSelf();
    new Function("self", src)(f.self);
    expect(Object.keys(f.handlers).sort()).toEqual(["activate", "fetch", "install"]);
  });
});
