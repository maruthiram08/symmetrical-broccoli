import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PhoneStore } from "./phone";
import { createPhoneHandler, forwardHeaders, lanAddress, pairPage, phoneConfig, phoneUrl, REMOTE_HEADER } from "./phone-proxy";

describe("lanAddress", () => {
  const ifaces = {
    lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    utun3: [{ address: "100.101.1.2", family: "IPv4", internal: false }],
    en0: [{ address: "fe80::1", family: "IPv6", internal: false }, { address: "192.168.1.20", family: "IPv4", internal: false }],
    docker0: [{ address: "8.8.8.8", family: "IPv4", internal: false }],
  } as unknown as ReturnType<typeof import("node:os").networkInterfaces>;

  it("picks the Wi-Fi/Ethernet private IPv4 address, never a public one or every interface", () => {
    expect(lanAddress({}, ifaces)).toBe("192.168.1.20");
    expect(lanAddress({}, { lo: ifaces.lo, docker0: ifaces.docker0 })).toBeNull();
    expect(lanAddress({}, { utun3: ifaces.utun3 })).toBe("100.101.1.2"); // Tailscale
    expect(lanAddress({ PHONE_BIND: "10.0.0.5" }, ifaces)).toBe("10.0.0.5");
  });

  it("validates the phone config", () => {
    expect(phoneConfig({ PHONE_BIND: "0.0.0.0" })).toEqual({ error: expect.stringMatching(/one address/) });
    expect(phoneConfig({ PHONE_BIND: "10.0.0.5", PHONE_PORT: "80" })).toEqual({ error: expect.stringMatching(/PHONE_PORT/) });
    expect(phoneConfig({ PHONE_BIND: "10.0.0.5", PHONE_TLS_CERT: "/nope", PHONE_TLS_KEY: "/nope" })).toEqual({ error: expect.stringMatching(/TLS/) });
    const c = phoneConfig({ PHONE_BIND: "10.0.0.5", PHONE_HOSTNAME: "Mac.tail1.ts.net" });
    expect(c).toMatchObject({ bind: "10.0.0.5", port: 4243, tls: null, hostnames: ["mac.tail1.ts.net"] });
    expect(phoneUrl(c as never)).toBe("http://mac.tail1.ts.net:4243");
  });
});

describe("forwardHeaders", () => {
  it("drops the tray header, any forged remote mark, the device cookie and the bearer token", () => {
    const out = forwardHeaders(
      { host: "10.0.0.5:4243", "x-daily-brief": "tray", [REMOTE_HEADER]: "forged", authorization: "Bearer t", cookie: "db_device=secret; theme=dark" },
      { id: "dev-1" } as never, false, "10.0.0.9",
    );
    expect(out["x-daily-brief"]).toBeUndefined();
    expect(out.authorization).toBeUndefined();
    expect(out[REMOTE_HEADER]).toBe("dev-1");
    expect(out.cookie).toBe("theme=dark");
    expect(out.host).toBe("10.0.0.5:4243"); // kept, so server actions' origin check passes
    expect(out["x-forwarded-for"]).toBe("10.0.0.9");
  });
});

describe("the phone door", () => {
  let upstream: http.Server, door: http.Server, port: number, phone: PhoneStore;
  const seen: Array<{ url: string; headers: http.IncomingHttpHeaders; body: string }> = [];

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ url: req.url ?? "", headers: req.headers, body });
        res.writeHead(200, { "content-type": "text/plain", "x-up": "1" });
        res.end(`upstream ${req.method} ${req.url}`);
      });
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    phone = new PhoneStore(join(mkdtempSync(join(tmpdir(), "db-door-")), "phone.json"));
    let handler: ReturnType<typeof createPhoneHandler> | null = null;
    door = http.createServer((req, res) => handler!(req, res));
    await new Promise<void>((r) => door.listen(0, "127.0.0.1", r));
    port = (door.address() as AddressInfo).port;
    handler = createPhoneHandler({
      phone,
      config: { bind: "127.0.0.1", port, tls: null, hostnames: [] },
      upstream: { host: "127.0.0.1", port: (upstream.address() as AddressInfo).port },
    });
  });
  afterAll(() => { door.close(); upstream.close(); });
  beforeEach(() => { seen.length = 0; phone.removeAll(); phone.setEnabled(true); });

  const req = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string; host?: string } = {}) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const r = http.request({ host: "127.0.0.1", port, path, method: init.method ?? "GET", headers: { host: init.host ?? `127.0.0.1:${port}`, ...init.headers } }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      });
      r.on("error", reject);
      r.end(init.body);
    });

  it("refuses other Host names (DNS rebinding)", async () => {
    expect((await req("/", { host: "evil.example:80" })).status).toBe(421);
    expect(seen).toHaveLength(0);
  });

  it("answers 503 while phone access is off", async () => {
    phone.setEnabled(false);
    expect((await req("/")).status).toBe(503);
  });

  it("sends an unpaired phone to the pairing page and refuses API calls", async () => {
    const home = await req("/");
    expect(home.status).toBe(303);
    expect(home.headers.location).toBe("/pair");
    expect((await req("/api/widget")).status).toBe(401);
    expect((await req("/pair")).body).toContain("Pair this phone");
    expect(seen).toHaveLength(0);
  });

  it("lets the manifest and icons through before pairing (Add to Home Screen)", async () => {
    expect((await req("/manifest.webmanifest")).body).toBe("upstream GET /manifest.webmanifest");
    expect((await req("/icons/maskable-512.png")).status).toBe(200);
    expect(seen[0].headers[REMOTE_HEADER]).toBe("public");
  });

  it("pairs with the code, sets an HttpOnly cookie, and forwards with the device marked", async () => {
    const { code } = phone.newPairingCode();
    const bad = await req("/pair", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "code=12345x" });
    expect(bad.status).toBe(401);
    const ok = await req("/pair", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "iPhone" }, body: `code=${code}` });
    expect(ok.status).toBe(303);
    const cookie = String(ok.headers["set-cookie"]);
    expect(cookie).toMatch(/^db_device=[\w-]+; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Lax$/);
    const token = cookie.split(";")[0];

    const page = await req("/open?x=1", { headers: { cookie: `${token}; theme=dark`, "x-daily-brief": "tray" } });
    expect(page.body).toBe("upstream GET /open?x=1");
    expect(page.headers["x-up"]).toBe("1");
    const h = seen[0].headers;
    expect(h[REMOTE_HEADER]).toBe(phone.read().devices[0].id);
    expect(h["x-daily-brief"]).toBeUndefined();
    expect(h.cookie).toBe("theme=dark");

    const post = await req("/", { method: "POST", headers: { cookie: token, "content-type": "text/plain" }, body: "hello" });
    expect(post.body).toBe("upstream POST /");
    expect(seen[1].body).toBe("hello");
  });

  it("lets a widget token read /api/widget and nothing else", async () => {
    const { token } = phone.createWidgetToken();
    expect((await req("/api/widget", { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    expect(seen[0].headers.authorization).toBeUndefined();
    const other = await req("/open", { headers: { authorization: `Bearer ${token}` } });
    expect(other.status).toBe(303);
    expect((await req("/api/widget", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
  });

  it("a removed phone is signed out", async () => {
    phone.newPairingCode();
    const { code } = phone.read().pairing!;
    const ok = await req("/pair", { method: "POST", body: `code=${code}` });
    const token = String(ok.headers["set-cookie"]).split(";")[0];
    phone.remove(phone.read().devices[0].id);
    expect((await req("/", { headers: { cookie: token } })).status).toBe(303);
  });

  it("escapes messages on the pairing page", () => {
    expect(pairPage("<script>")).toContain("&#60;script&#62;");
  });
});
