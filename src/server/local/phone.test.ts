import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bearer, cookieValue, deviceName, hashToken, PhoneStore, PAIRING_TTL_MS } from "./phone";

function store(start = Date.parse("2026-11-26T10:00:00Z")) {
  let now = start;
  const s = new PhoneStore(join(mkdtempSync(join(tmpdir(), "db-phone-")), "phone.json"), () => new Date(now));
  return { s, advance: (ms: number) => { now += ms; } };
}

describe("phone access store", () => {
  it("is off by default with no devices", () => {
    const { s } = store();
    expect(s.read()).toEqual({ enabled: false, pairing: null, devices: [] });
  });

  it("pairs a phone with a one-time code and keeps only the token's hash, readable only by you", () => {
    const { s } = store();
    s.setEnabled(true);
    const p = s.newPairingCode();
    expect(p.code).toMatch(/^\d{6}$/);
    const r = s.redeem(`${p.code.slice(0, 3)} ${p.code.slice(3)}`, "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.device).toMatchObject({ kind: "phone", name: "iPhone" });
    const file = readFileSync(s.path, "utf8");
    expect(file).not.toContain(r.token);
    expect(file).toContain(hashToken(r.token));
    expect(statSync(s.path).mode & 0o777).toBe(0o600);
    expect(s.verify(r.token)?.id).toBe(r.device.id);
    // The code is used up.
    expect(s.redeem(p.code)).toEqual({ ok: false, error: "none" });
  });

  it("refuses codes while phone access is off", () => {
    const { s } = store();
    s.setEnabled(true);
    const p = s.newPairingCode();
    s.setEnabled(false);
    expect(s.redeem(p.code)).toEqual({ ok: false, error: "none" });
  });

  it("expires codes after 10 minutes", () => {
    const { s, advance } = store();
    s.setEnabled(true);
    const p = s.newPairingCode();
    advance(PAIRING_TTL_MS + 1);
    expect(s.activePairing()).toBeNull();
    expect(s.redeem(p.code)).toEqual({ ok: false, error: "expired" });
  });

  it("drops the code after 5 wrong tries", () => {
    const { s } = store();
    s.setEnabled(true);
    const p = s.newPairingCode();
    const wrong = p.code === "000000" ? "111111" : "000000";
    for (let k = 0; k < 4; k++) expect(s.redeem(wrong)).toEqual({ ok: false, error: "wrong" });
    expect(s.redeem(wrong)).toEqual({ ok: false, error: "used_up" });
    expect(s.redeem(p.code)).toEqual({ ok: false, error: "none" });
  });

  it("widget tokens are their own kind and can be removed", () => {
    const { s } = store();
    const { token, device } = s.createWidgetToken("Home widget");
    expect(device.kind).toBe("widget");
    expect(s.verify(token, ["phone"])).toBeNull();
    expect(s.verify(token)?.name).toBe("Home widget");
    s.remove(device.id);
    expect(s.verify(token)).toBeNull();
  });

  it("rejects unknown, empty and oversized tokens, and notes when a device was last used", () => {
    const { s, advance } = store();
    const { token } = s.createWidgetToken();
    expect(s.verify("nope")).toBeNull();
    expect(s.verify("")).toBeNull();
    expect(s.verify("x".repeat(500))).toBeNull();
    s.verify(token);
    const first = s.read().devices[0].lastSeenAt;
    expect(first).toBe("2026-11-26T10:00:00.000Z");
    advance(60_000);
    s.verify(token);
    expect(s.read().devices[0].lastSeenAt).toBe(first); // not rewritten every request
    advance(10 * 60_000);
    s.verify(token);
    expect(s.read().devices[0].lastSeenAt).not.toBe(first);
  });

  it("sign out all phones removes every device and the code", () => {
    const { s } = store();
    s.setEnabled(true);
    s.newPairingCode();
    s.createWidgetToken();
    s.removeAll();
    expect(s.read()).toMatchObject({ enabled: true, pairing: null, devices: [] });
  });

  it("reads cookies, bearer tokens and device names", () => {
    expect(cookieValue("a=1; db_device=abc%3D; b=2", "db_device")).toBe("abc=");
    expect(cookieValue(undefined, "db_device")).toBeNull();
    expect(bearer("Bearer tok123")).toBe("tok123");
    expect(bearer("Basic x")).toBeNull();
    expect(deviceName("Mozilla/5.0 (Linux; Android 15; Pixel 9)")).toBe("Android phone");
    expect(deviceName("Mozilla/5.0 (iPad; CPU OS 18_0)")).toBe("iPad");
    expect(deviceName(undefined)).toBe("Phone");
  });
});
