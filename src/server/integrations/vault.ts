// Integration tokens and the local API / webhook secrets. In the Mac app (DAILY_BRIEF_KEYCHAIN=1)
// they live in the macOS Keychain (service app.dailybrief); elsewhere (npm start, dev, tests) in
// <data>/secrets.json, readable only by you (0600). Values are never logged or sent to the browser.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { keychainMode, macKeychain, safeSecret, type IntegrationSecret, type Keychain } from "@/server/local/keychain";
import { dataDir } from "@/server/local/paths";

export type { IntegrationSecret };

export interface Vault {
  get(name: IntegrationSecret): Promise<string | null>;
  /** False when the value can't be stored (bad characters, or the Keychain refused). */
  set(name: IntegrationSecret, value: string): Promise<boolean>;
  remove(name: IntegrationSecret): Promise<void>;
  /** "keychain" or "file", for the Settings hint. */
  readonly where: "keychain" | "file";
}

/** A file-backed vault: one JSON object, written atomically, 0600. */
export function fileVault(path: string): Vault {
  const read = (): Record<string, string> => {
    try {
      return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, string>) : {};
    } catch {
      return {};
    }
  };
  const write = (s: Record<string, string>) => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(`${path}.tmp`, JSON.stringify(s), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
    chmodSync(path, 0o600);
  };
  return {
    where: "file",
    async get(name) { return read()[name] ?? null; },
    async set(name, value) {
      if (!safeSecret(value)) return false;
      write({ ...read(), [name]: value });
      return true;
    },
    async remove(name) {
      const s = read();
      if (!(name in s)) return;
      delete s[name];
      write(s);
    },
  };
}

/** The Keychain, with reads cached in memory (each read starts /usr/bin/security). */
export function keychainVault(kc: Keychain = macKeychain): Vault {
  const cache = new Map<IntegrationSecret, string | null>();
  return {
    where: "keychain",
    async get(name) {
      if (!cache.has(name)) cache.set(name, await kc.read(name));
      return cache.get(name) ?? null;
    },
    async set(name, value) {
      if (!safeSecret(value)) return false;
      const ok = await kc.write(name, value);
      cache.delete(name);
      return ok;
    },
    async remove(name) {
      await kc.remove?.(name);
      cache.set(name, null);
    },
  };
}

const g = globalThis as unknown as { __dbVault?: Vault };

export function getVault(): Vault {
  g.__dbVault ??= keychainMode() ? keychainVault() : fileVault(join(dataDir(), "secrets.json"));
  return g.__dbVault;
}

/** Tests: use this vault instead. */
export function setVault(v: Vault | undefined): void {
  g.__dbVault = v;
}

/** "••••3f9a": enough to recognise a saved token, never the token. */
export function lastFour(value: string | null): string | null {
  return value ? `••••${value.slice(-4)}` : null;
}
