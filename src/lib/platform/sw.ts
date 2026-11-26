// The service worker, written as one self-contained function so it can be unit-tested here and
// served as /sw.js (src/app/sw.js/route.ts) with `(${swMain})(self, config)`. It must not use
// anything from outside its own body: it runs in the browser, not in this module.
//
// What it does:
// - Today, All open and People (and any person or item page you opened) are fetched from the
//   network first and kept in a cache, so they still open, read-only, when the network or the Mac
//   is away. Without a cached copy you get the /offline page.
// - Built assets (/_next/static, hashed file names) are cache-first.
// - Nothing else is cached: API calls, server actions (POST) and RSC requests always go to the network.

export interface SwConfig {
  version: string;
  /** Pages fetched into the cache at install, so they work offline before you ever open them. */
  pages: string[];
  /** Other pages kept once you open them. */
  prefixes: string[];
  offline: string;
  /** How long a page waits for the network before the cached copy is shown. */
  timeoutMs: number;
}

export const SW_CONFIG: Omit<SwConfig, "version"> = {
  pages: ["/", "/open", "/people"],
  prefixes: ["/people/", "/item/"],
  offline: "/offline",
  timeoutMs: 4000,
};

/* eslint-disable @typescript-eslint/no-explicit-any */
export function swMain(self: any, cfg: SwConfig): void {
  const PAGES = "db-pages-" + cfg.version;
  const STATIC = "db-static-" + cfg.version;

  const cacheable = (path: string) => cfg.pages.indexOf(path) !== -1 || cfg.prefixes.some((p) => path.indexOf(p) === 0);

  self.addEventListener("install", (event: any) => {
    event.waitUntil(
      (async () => {
        const c = await self.caches.open(PAGES);
        await c.add(cfg.offline);
        // Best effort: a page that fails now is cached the first time you open it.
        await Promise.all(cfg.pages.map((p) => c.add(p).catch(() => undefined)));
        await self.skipWaiting();
      })(),
    );
  });

  self.addEventListener("activate", (event: any) => {
    event.waitUntil(
      (async () => {
        for (const k of await self.caches.keys()) if (k.indexOf("db-") === 0 && k !== PAGES && k !== STATIC) await self.caches.delete(k);
        await self.clients.claim();
      })(),
    );
  });

  const withTimeout = (p: Promise<any>, ms: number) =>
    new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout")), ms);
      p.then((r) => { clearTimeout(t); resolve(r); }, (e) => { clearTimeout(t); reject(e); });
    });

  async function page(req: any, path: string): Promise<any> {
    const c = await self.caches.open(PAGES);
    const net = fetch(req);
    try {
      const res = await withTimeout(net, cfg.timeoutMs);
      if (res && res.ok && !res.redirected) await c.put(path, res.clone());
      return res;
    } catch {
      const hit = await c.match(path);
      if (hit) {
        // Keep the slow request going so the cache is fresh next time.
        net.then((res: any) => (res && res.ok && !res.redirected ? c.put(path, res.clone()) : undefined)).catch(() => undefined);
        return hit;
      }
      try { return await net; } catch { return (await c.match(cfg.offline)) || Response.error(); }
    }
  }

  async function asset(req: any): Promise<any> {
    const c = await self.caches.open(STATIC);
    const hit = await c.match(req);
    if (hit) return hit;
    const res = await fetch(req);
    if (res && res.ok) await c.put(req, res.clone());
    return res;
  }

  self.addEventListener("fetch", (event: any) => {
    const req = event.request;
    if (req.method !== "GET") return;
    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;
    if (url.pathname.indexOf("/_next/static/") === 0) return event.respondWith(asset(req));
    if (url.pathname.indexOf("/api/") === 0 || req.headers.get("RSC") || url.searchParams.has("_rsc")) return;
    if (req.mode !== "navigate") return;
    if (cacheable(url.pathname)) return event.respondWith(page(req, url.pathname));
    event.respondWith(
      fetch(req).catch(async () => (await (await self.caches.open(PAGES)).match(cfg.offline)) || Response.error()),
    );
  });
}

/** The /sw.js source. */
export function swSource(version: string): string {
  const cfg: SwConfig = { ...SW_CONFIG, version };
  return `"use strict";\n(${swMain.toString()})(self, ${JSON.stringify(cfg)});\n`;
}
