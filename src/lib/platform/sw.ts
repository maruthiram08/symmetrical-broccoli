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
  /** The page shown for a page never saved: self-contained HTML (no scripts to load offline). */
  offlineHtml: string;
  /** How long a page waits for the network before the cached copy is shown. */
  timeoutMs: number;
}

export const SW_CONFIG: Omit<SwConfig, "version"> = {
  pages: ["/", "/open", "/people"],
  prefixes: ["/people/", "/item/"],
  offlineHtml: offlinePage(),
  timeoutMs: 4000,
};

/** The offline page. Plain HTML and CSS in the app's colours, so it needs nothing from the network. */
export function offlinePage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Offline · Daily brief</title><meta name="color-scheme" content="light dark">
<style>
:root{--bg:#fff;--ink:#0a0a0a;--muted:#525252;--line:#ececec;--lime:#d6ff3d;--on-ink:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0b0b0c;--ink:#f4f4f5;--muted:#a1a1aa;--line:#1f1f23;--on-ink:#0a0a0a}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 -apple-system,"Segoe UI",system-ui,sans-serif}
main{max-width:480px;margin:0 auto;padding:48px 16px}
.brand{display:flex;align-items:center;gap:10px;font-weight:600;margin-bottom:40px}.brand i{width:14px;height:14px;border-radius:4px;background:var(--lime);box-shadow:inset 0 0 0 1.5px var(--ink)}
h1{font-size:32px;line-height:1.1;letter-spacing:-.02em;margin:0 0 12px}p{color:var(--muted);margin:0 0 24px}
ul{list-style:none;margin:0 0 24px;padding:0;border-top:1px solid var(--line)}li{padding:12px 0;border-bottom:1px solid var(--line)}
a{color:var(--ink);font-weight:600;text-decoration:none}li span{display:block;color:var(--muted);font-size:13px}
button{border:0;border-radius:999px;background:var(--ink);color:var(--on-ink);font:600 15px inherit;padding:12px 20px}
</style></head><body><main>
<div class="brand"><i></i>Daily brief</div>
<h1>You're offline</h1>
<p>This page isn't saved on this device, and your Mac can't be reached right now. These were saved the last time you opened them, and open without a connection:</p>
<ul><li><a href="/">Today</a><span>What you owe, waiting on and decisions</span></li><li><a href="/open">All open</a><span>Everything still open</span></li><li><a href="/people">People</a><span>Who owes what, by person</span></li></ul>
<p>Saved pages are read-only. Done, Snooze and Add work again once you can reach your Mac.</p>
<button type="button" onclick="location.reload()">Try again</button>
</main></body></html>`;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function swMain(self: any, cfg: SwConfig): void {
  const PAGES = "db-pages-" + cfg.version;
  const STATIC = "db-static-" + cfg.version;

  const cacheable = (path: string) => cfg.pages.indexOf(path) !== -1 || cfg.prefixes.some((p) => path.indexOf(p) === 0);

  self.addEventListener("install", (event: any) => {
    event.waitUntil(
      (async () => {
        const c = await self.caches.open(PAGES);
        const s = await self.caches.open(STATIC);
        // Best effort: a page that fails now is cached the first time you open it. Each page's
        // scripts and styles are saved too, so a page you never opened still works offline.
        await Promise.all(
          cfg.pages.map(async (p) => {
            try {
              const res = await fetch(p, { credentials: "same-origin" });
              if (!res.ok || res.redirected) return;
              await c.put(p, res.clone());
              const assets = ((await res.text()).match(/\/_next\/static\/[^"'\s)\\]+/g) || []) as string[];
              await Promise.all(assets.filter((a, i) => assets.indexOf(a) === i).map((a) => s.add(a).catch(() => undefined)));
            } catch {
              /* offline at install */
            }
          }),
        );
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
      try { return await net; } catch { return offline(); }
    }
  }

  function offline(): any {
    return new Response(cfg.offlineHtml, { status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
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
    event.respondWith(fetch(req).catch(offline));
  });
}

/** The /sw.js source. */
export function swSource(version: string): string {
  const cfg: SwConfig = { ...SW_CONFIG, version };
  return `"use strict";\n(${swMain.toString()})(self, ${JSON.stringify(cfg)});\n`;
}
