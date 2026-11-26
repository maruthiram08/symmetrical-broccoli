// Phone access: which phones (and widget Shortcuts) may open this app over the LAN.
//
// Off by default. Lives in <data>/phone.json (0600). Tokens are 32 random bytes; only their
// SHA-256 is stored, so the file alone can't be used to sign in. A pairing code is 6 digits,
// valid for 10 minutes and 5 tries, and is used up by the first phone that enters it.
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { homeDataDir as dataDir } from "./workspaces";
import { readJson, writeJson } from "./json-file";

export type DeviceKind = "phone" | "widget";

export interface Device {
  id: string;
  /** "iPhone", "Android phone", or what you named a widget token. */
  name: string;
  kind: DeviceKind;
  tokenHash: string;
  createdAt: string;
  lastSeenAt: string | null;
}

export interface Pairing {
  code: string;
  expiresAt: string;
  attemptsLeft: number;
}

export interface PhoneState {
  enabled: boolean;
  pairing: Pairing | null;
  devices: Device[];
}

export const PAIRING_TTL_MS = 10 * 60_000;
export const PAIRING_TRIES = 5;
export const DEVICE_COOKIE = "db_device";
/** Writing lastSeenAt on every request would rewrite the file constantly; once in a while is enough. */
const SEEN_EVERY_MS = 5 * 60_000;

const EMPTY: PhoneState = { enabled: false, pairing: null, devices: [] };

export const hashToken = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");

function sameHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex"), y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** "iPhone", "Android phone", "iPad", or "Phone" from a User-Agent. Never stores the UA itself. */
export function deviceName(userAgent: string | undefined): string {
  const ua = userAgent ?? "";
  if (/iPad/i.test(ua)) return "iPad";
  if (/iPhone/i.test(ua)) return "iPhone";
  if (/Android/i.test(ua)) return "Android phone";
  if (/Macintosh|Windows|Linux/i.test(ua)) return "Computer";
  return "Phone";
}

export type RedeemResult =
  | { ok: true; token: string; device: Device }
  | { ok: false; error: "none" | "expired" | "wrong" | "used_up" };

export class PhoneStore {
  constructor(readonly path: string, private readonly now: () => Date = () => new Date()) {}

  read(): PhoneState {
    const s = readJson<PhoneState>(this.path, EMPTY);
    return { enabled: s.enabled === true, pairing: s.pairing ?? null, devices: Array.isArray(s.devices) ? s.devices : [] };
  }

  private change(fn: (s: PhoneState) => void): PhoneState {
    const s = this.read();
    fn(s);
    writeJson(this.path, s);
    return s;
  }

  setEnabled(on: boolean): PhoneState {
    return this.change((s) => {
      s.enabled = on;
      if (!on) s.pairing = null;
    });
  }

  /** A fresh 6-digit code; any earlier code stops working. */
  newPairingCode(): Pairing {
    const pairing: Pairing = {
      code: String(randomInt(0, 1_000_000)).padStart(6, "0"),
      expiresAt: new Date(this.now().getTime() + PAIRING_TTL_MS).toISOString(),
      attemptsLeft: PAIRING_TRIES,
    };
    this.change((s) => { s.pairing = pairing; });
    return pairing;
  }

  /** The current code, or null when there is none or it ran out. */
  activePairing(): Pairing | null {
    const p = this.read().pairing;
    return p && Date.parse(p.expiresAt) > this.now().getTime() && p.attemptsLeft > 0 ? p : null;
  }

  /** A phone enters the code: on a match it gets a new device token, and the code is used up. */
  redeem(code: string, userAgent?: string): RedeemResult {
    let out: RedeemResult = { ok: false, error: "none" };
    this.change((s) => {
      const p = s.pairing;
      if (!s.enabled || !p) { out = { ok: false, error: "none" }; return; }
      if (Date.parse(p.expiresAt) <= this.now().getTime()) { s.pairing = null; out = { ok: false, error: "expired" }; return; }
      const given = Buffer.from(code.replace(/\D/g, "").slice(0, 6).padEnd(6, "x"));
      if (!timingSafeEqual(given, Buffer.from(p.code))) {
        p.attemptsLeft -= 1;
        if (p.attemptsLeft <= 0) { s.pairing = null; out = { ok: false, error: "used_up" }; }
        else out = { ok: false, error: "wrong" };
        return;
      }
      s.pairing = null;
      const token = randomBytes(32).toString("base64url");
      const device = this.newDevice("phone", deviceName(userAgent), token);
      s.devices.push(device);
      out = { ok: true, token, device };
    });
    return out;
  }

  /** A token for the iOS Shortcut / widget. Shown once; it can only read /api/widget. */
  createWidgetToken(name = "Widget"): { token: string; device: Device } {
    const token = randomBytes(32).toString("base64url");
    const device = this.newDevice("widget", name.trim().slice(0, 40) || "Widget", token);
    this.change((s) => { s.devices.push(device); });
    return { token, device };
  }

  private newDevice(kind: DeviceKind, name: string, token: string): Device {
    return { id: randomUUID(), name, kind, tokenHash: hashToken(token), createdAt: this.now().toISOString(), lastSeenAt: null };
  }

  /** The device a token belongs to, or null. Notes when it was last used (at most every 5 minutes). */
  verify(token: string | null | undefined, kinds: DeviceKind[] = ["phone", "widget"]): Device | null {
    if (!token || token.length > 200) return null;
    const h = hashToken(token);
    const s = this.read();
    const d = s.devices.find((x) => kinds.includes(x.kind) && sameHex(x.tokenHash, h)) ?? null;
    if (d) {
      const nowMs = this.now().getTime();
      if (!d.lastSeenAt || nowMs - Date.parse(d.lastSeenAt) > SEEN_EVERY_MS) {
        try {
          this.change((st) => { const x = st.devices.find((y) => y.id === d.id); if (x) x.lastSeenAt = new Date(nowMs).toISOString(); });
        } catch { /* a read-only disk must not lock the phone out */ }
      }
    }
    return d;
  }

  hasDevice(id: string): boolean {
    return this.read().devices.some((d) => d.id === id);
  }

  remove(id: string): void {
    this.change((s) => { s.devices = s.devices.filter((d) => d.id !== id); });
  }

  removeAll(): void {
    this.change((s) => { s.devices = []; s.pairing = null; });
  }
}

const g = globalThis as unknown as { __dbPhone?: PhoneStore };
export function getPhoneStore(): PhoneStore {
  const path = join(dataDir(), "phone.json");
  if (!g.__dbPhone || g.__dbPhone.path !== path) g.__dbPhone = new PhoneStore(path);
  return g.__dbPhone;
}

/** Reads one cookie from a Cookie header. */
export function cookieValue(header: string | undefined | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/** "Bearer abc" -> "abc". */
export function bearer(header: string | undefined | null): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  return m ? m[1] : null;
}
