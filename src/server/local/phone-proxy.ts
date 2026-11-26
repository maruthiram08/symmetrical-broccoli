// The phone door: a small HTTP(S) server on your LAN address that lets paired phones in.
//
// The app itself keeps listening on 127.0.0.1 only. When Phone access is on, this server binds to
// the Mac's LAN address (say 192.168.1.20:4243) and forwards each request to 127.0.0.1 only after
// checking the phone's device cookie (or a widget token). Everything else gets the pairing page.
// It also refuses any Host header that isn't its own address (DNS rebinding), drops the
// x-daily-brief tray header, and marks every forwarded request with x-daily-brief-remote, so
// Mac-only settings can't be changed from a phone.
import { readFileSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import { networkInterfaces } from "node:os";
import { bearer, cookieValue, DEVICE_COOKIE, getPhoneStore, type Device, type PhoneStore } from "./phone";
import { PORT } from "./paths";

export const REMOTE_HEADER = "x-daily-brief-remote";
export const PHONE_PORT_DEFAULT = 4243;
/** Paths a phone may load before pairing: they hold no data (needed for "Add to Home Screen"). */
const PUBLIC = /^\/(manifest\.webmanifest|sw\.js|icons\/[\w.@-]+\.png|favicon\.ico|apple-touch-icon\.png)$/;
const ONE_YEAR = 365 * 24 * 60 * 60;

const isPrivateV4 = (a: string) =>
  /^10\./.test(a) || /^192\.168\./.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a);

/**
 * The address to listen on: PHONE_BIND when set, else the first private IPv4 address of a
 * Wi-Fi or Ethernet interface (10/8, 172.16/12, 192.168/16, or Tailscale's 100.64/10). Never 0.0.0.0.
 */
export function lanAddress(env: Record<string, string | undefined> = process.env, ifaces = networkInterfaces()): string | null {
  if (env.PHONE_BIND) return env.PHONE_BIND;
  const all = Object.entries(ifaces).flatMap(([name, list]) => (list ?? []).map((i) => ({ name, ...i })));
  const ok = all.filter((i) => i.family === "IPv4" && !i.internal && isPrivateV4(i.address));
  // Prefer the usual Wi-Fi / Ethernet names over VPNs and bridges.
  const rank = (n: string) => (/^(en0|wlan|wl|eth|en)/.test(n) ? 0 : /^(utun|tailscale|ts)/.test(n) ? 2 : 1);
  ok.sort((a, b) => rank(a.name) - rank(b.name));
  return ok[0]?.address ?? null;
}

export interface PhoneConfig {
  bind: string;
  port: number;
  tls: { cert: Buffer; key: Buffer } | null;
  /** Extra names the phone may use for this Mac (PHONE_HOSTNAME, say a Tailscale MagicDNS name). */
  hostnames: string[];
}

export function phoneConfig(env: Record<string, string | undefined> = process.env): PhoneConfig | { error: string } {
  const bind = lanAddress(env);
  if (!bind) return { error: "This Mac has no Wi-Fi or Ethernet address right now." };
  if (bind === "0.0.0.0" || bind === "::") return { error: "PHONE_BIND must be one address, not every interface." };
  const port = Number(env.PHONE_PORT ?? PHONE_PORT_DEFAULT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === PORT) return { error: "PHONE_PORT must be a free port above 1024." };
  let tls: PhoneConfig["tls"] = null;
  if (env.PHONE_TLS_CERT && env.PHONE_TLS_KEY) {
    try {
      tls = { cert: readFileSync(env.PHONE_TLS_CERT), key: readFileSync(env.PHONE_TLS_KEY) };
    } catch {
      return { error: "Couldn't read PHONE_TLS_CERT or PHONE_TLS_KEY." };
    }
  }
  const hostnames = (env.PHONE_HOSTNAME ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  return { bind, port, tls, hostnames };
}

export function phoneUrl(c: Pick<PhoneConfig, "bind" | "port" | "tls" | "hostnames">): string {
  return `${c.tls ? "https" : "http"}://${c.hostnames[0] ?? c.bind}:${c.port}`;
}

export interface HandlerOpts {
  phone: PhoneStore;
  config: Pick<PhoneConfig, "bind" | "port" | "tls" | "hostnames">;
  upstream: { host: string; port: number };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The pairing page. Self-contained (no app CSS: the phone isn't signed in yet). */
export function pairPage(message: string | null): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pair · Daily brief</title><meta name="color-scheme" content="light dark"><link rel="manifest" href="/manifest.webmanifest">
<style>
:root{--ink:#0b0b0c;--muted:#6b6b70;--bg:#fff;--line:#e6e6e8;--lime:#d9f99d;--red:#d92d20}
@media (prefers-color-scheme:dark){:root{--ink:#f4f4f5;--muted:#a1a1aa;--bg:#0b0b0c;--line:#27272a;--lime:#3f6212}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 system-ui,-apple-system,sans-serif}
main{max-width:360px;margin:0 auto;padding:64px 16px}
h1{font-size:22px;font-weight:600;margin:0 0 8px}p{color:var(--muted);margin:0 0 24px}
input{box-sizing:border-box;width:100%;font:600 28px/1 ui-monospace,monospace;letter-spacing:.3em;text-align:center;padding:14px;border:1px solid var(--line);border-radius:12px;background:transparent;color:var(--ink)}
button{margin-top:16px;width:100%;padding:14px;border:0;border-radius:999px;background:var(--ink);color:var(--bg);font:600 16px system-ui,sans-serif}
.err{color:var(--red);margin:16px 0 0}
</style></head><body><main>
<h1>Pair this phone</h1>
<p>On your Mac, open Daily brief › Settings › Phone access and press <b>New pairing code</b>. Enter the 6 digits here.</p>
<form method="post" action="/pair"><input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" required autofocus aria-label="Pairing code">
<button type="submit">Pair</button></form>
${message ? `<p class="err" role="alert">${esc(message)}</p>` : ""}
</main></body></html>`;
}

const REDEEM_ERRORS: Record<string, string> = {
  none: "There's no pairing code right now. Make a new one on your Mac.",
  expired: "That code has expired. Make a new one on your Mac.",
  wrong: "That code isn't right. Check it and try again.",
  used_up: "Too many wrong tries. Make a new code on your Mac.",
};

function readBody(req: IncomingMessage, limit = 2048): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new Error("too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: string, type = "text/html; charset=utf-8", extra: Record<string, string | string[]> = {}): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra });
  res.end(body);
}

/** Who is asking: a paired phone (cookie), a token (Authorization: Bearer), or nobody. */
export function authenticate(phone: PhoneStore, req: Pick<IncomingMessage, "headers">, path: string): Device | null {
  const tok = bearer(req.headers.authorization);
  if (tok) {
    const d = phone.verify(tok);
    // A widget token reads the widget and nothing else.
    return d && (d.kind === "phone" || path === "/api/widget") ? d : null;
  }
  return phone.verify(cookieValue(req.headers.cookie, DEVICE_COOKIE), ["phone"]);
}

/** Request headers for 127.0.0.1: the phone's own cookie and any tray header removed, the remote mark added. */
export function forwardHeaders(h: IncomingMessage["headers"], device: Device | null, secure: boolean, remoteAddr: string | undefined): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = { ...h };
  delete out["x-daily-brief"];
  delete out[REMOTE_HEADER];
  delete out.authorization;
  if (typeof h.cookie === "string") {
    const rest = h.cookie.split(";").map((p) => p.trim()).filter((p) => p && !p.startsWith(`${DEVICE_COOKIE}=`)).join("; ");
    if (rest) out.cookie = rest; else delete out.cookie;
  }
  out[REMOTE_HEADER] = device?.id ?? "public";
  out["x-forwarded-proto"] = secure ? "https" : "http";
  if (remoteAddr) out["x-forwarded-for"] = remoteAddr;
  return out;
}

export function createPhoneHandler(o: HandlerOpts): (req: IncomingMessage, res: ServerResponse) => void {
  const allowed = new Set([`${o.config.bind}:${o.config.port}`, ...o.config.hostnames.map((h) => `${h}:${o.config.port}`)]);
  const secure = !!o.config.tls;
  return (req, res) => {
    void (async () => {
      const host = (req.headers.host ?? "").toLowerCase();
      if (!allowed.has(host)) return send(res, 421, "Unknown host.", "text/plain; charset=utf-8");
      if (!o.phone.read().enabled) return send(res, 503, "Phone access is off. Turn it on in Settings on your Mac.", "text/plain; charset=utf-8");
      const url = new URL(req.url ?? "/", "http://x");
      const path = url.pathname;

      if (path === "/pair") {
        if (req.method === "POST") {
          let code = "";
          try { code = new URLSearchParams(await readBody(req)).get("code") ?? ""; } catch { return send(res, 413, pairPage("That didn't look like a code.")); }
          const r = o.phone.redeem(code, req.headers["user-agent"]);
          if (!r.ok) return send(res, r.error === "wrong" ? 401 : 410, pairPage(REDEEM_ERRORS[r.error]));
          const cookie = `${DEVICE_COOKIE}=${r.token}; Path=/; Max-Age=${ONE_YEAR}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
          return send(res, 303, "", "text/plain", { location: "/", "set-cookie": cookie });
        }
        return send(res, 200, pairPage(null));
      }

      const device = authenticate(o.phone, req, path);
      if (!device && !(req.method === "GET" && PUBLIC.test(path))) {
        if (path.startsWith("/api/")) return send(res, 401, JSON.stringify({ error: "not paired" }), "application/json");
        return send(res, 303, "", "text/plain", { location: "/pair" });
      }

      const up = http.request(
        { host: o.upstream.host, port: o.upstream.port, method: req.method, path: req.url, headers: forwardHeaders(req.headers, device, secure, req.socket.remoteAddress) },
        (ur) => {
          res.writeHead(ur.statusCode ?? 502, ur.headers);
          ur.pipe(res);
        },
      );
      up.on("error", () => { if (!res.headersSent) send(res, 502, "Daily brief isn't answering on this Mac.", "text/plain; charset=utf-8"); else res.destroy(); });
      req.pipe(up);
    })().catch(() => { if (!res.headersSent) send(res, 500, "Something went wrong.", "text/plain; charset=utf-8"); });
  };
}

// ---------- the running server (one per process) ----------

export interface PhoneStatus {
  enabled: boolean;
  listening: boolean;
  url: string | null;
  secure: boolean;
  error: string | null;
}

const g = globalThis as unknown as { __dbPhoneServer?: { server: http.Server; key: string; url: string; secure: boolean } | null; __dbPhoneError?: string | null };

export function phoneStatus(): PhoneStatus {
  const s = g.__dbPhoneServer;
  return { enabled: getPhoneStore().read().enabled, listening: !!s, url: s?.url ?? null, secure: s?.secure ?? false, error: g.__dbPhoneError ?? null };
}

function close(): Promise<void> {
  const s = g.__dbPhoneServer;
  g.__dbPhoneServer = null;
  if (!s) return Promise.resolve();
  return new Promise((r) => { s.server.close(() => r()); s.server.closeAllConnections?.(); });
}

/** Starts or stops the phone server to match the Phone access setting. Never throws. */
export async function syncPhoneAccess(env: Record<string, string | undefined> = process.env): Promise<PhoneStatus> {
  const phone = getPhoneStore();
  if (!phone.read().enabled) {
    await close();
    g.__dbPhoneError = null;
    return phoneStatus();
  }
  const cfg = phoneConfig(env);
  if ("error" in cfg) {
    await close();
    g.__dbPhoneError = cfg.error;
    return phoneStatus();
  }
  const key = `${cfg.bind}:${cfg.port}:${cfg.tls ? "tls" : "plain"}:${cfg.hostnames.join(",")}`;
  if (g.__dbPhoneServer?.key === key) return phoneStatus();
  await close();
  const handler = createPhoneHandler({ phone, config: cfg, upstream: { host: "127.0.0.1", port: PORT } });
  const server = cfg.tls ? https.createServer({ cert: cfg.tls.cert, key: cfg.tls.key }, handler) : http.createServer(handler);
  server.headersTimeout = 20_000;
  server.requestTimeout = 120_000;
  const err = await new Promise<string | null>((resolve) => {
    server.once("error", (e: NodeJS.ErrnoException) => resolve(e.code === "EADDRINUSE" ? `Port ${cfg.port} is already in use on ${cfg.bind}.` : `Couldn't listen on ${cfg.bind}:${cfg.port} (${e.code ?? "error"}).`));
    server.listen(cfg.port, cfg.bind, () => resolve(null));
  });
  if (err) {
    g.__dbPhoneError = err;
    console.error(`[phone] ${err}`);
    return phoneStatus();
  }
  server.unref();
  g.__dbPhoneError = null;
  g.__dbPhoneServer = { server, key, url: phoneUrl(cfg), secure: !!cfg.tls };
  console.error(`[phone] phone access on at ${phoneUrl(cfg)}`);
  return phoneStatus();
}

/** True when a request came through the phone door rather than from this Mac. */
export function isRemote(h: { get(name: string): string | null }): boolean {
  return h.get(REMOTE_HEADER) !== null;
}
