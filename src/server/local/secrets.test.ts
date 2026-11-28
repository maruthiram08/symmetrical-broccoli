import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env, Keychain, SecretName } from "./keychain";
import { loadSecrets } from "./secrets";

function fakeKeychain(initial: Partial<Record<SecretName, string>> = {}, writable = true) {
  const items = new Map(Object.entries(initial)) as Map<SecretName, string>;
  const kc: Keychain = {
    available: () => true,
    read: async (n) => items.get(n) ?? null,
    write: async (n, v) => (writable ? (items.set(n, v), true) : false),
  };
  return { kc, items };
}

let dir: string;
const prevDir = process.env.DAILY_BRIEF_DIR;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "db-secrets-"));
  process.env.DAILY_BRIEF_DIR = dir;
});
afterEach(() => {
  if (prevDir === undefined) delete process.env.DAILY_BRIEF_DIR;
  else process.env.DAILY_BRIEF_DIR = prevDir;
});
const keyFile = () => join(dir, ".daily-brief", "key");
const KEY = Buffer.alloc(32, 7).toString("base64");

describe("loadSecrets under the Mac app", () => {
  it("reads both secrets from the Keychain and non-secret settings from settings.env", async () => {
    const { kc } = fakeKeychain({ ANTHROPIC_API_KEY: "sk-ant-test-123", TOKEN_ENCRYPTION_KEY: KEY });
    mkdirSync(join(dir, ".daily-brief"), { recursive: true });
    writeFileSync(join(dir, ".daily-brief", "settings.env"), "EXTRACTION_MODEL=claude-x\nANTHROPIC_API_KEY=nope\n");
    const env: Env = { DAILY_BRIEF_KEYCHAIN: "1" };
    const from = await loadSecrets(kc, env);
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-test-123");
    expect(env.TOKEN_ENCRYPTION_KEY).toBe(KEY);
    expect(env.EXTRACTION_MODEL).toBe("claude-x");
    expect(from).toEqual({ ANTHROPIC_API_KEY: "keychain", TOKEN_ENCRYPTION_KEY: "keychain" });
  });

  it("moves an existing key file into the Keychain and deletes the file", async () => {
    const { kc, items } = fakeKeychain();
    mkdirSync(join(dir, ".daily-brief"), { recursive: true });
    writeFileSync(keyFile(), KEY + "\n");
    const env: Env = { DAILY_BRIEF_KEYCHAIN: "1" };
    const from = await loadSecrets(kc, env);
    expect(items.get("TOKEN_ENCRYPTION_KEY")).toBe(KEY);
    expect(env.TOKEN_ENCRYPTION_KEY).toBe(KEY);
    expect(existsSync(keyFile())).toBe(false);
    expect(from.TOKEN_ENCRYPTION_KEY).toBe("moved-to-keychain");
  });

  it("generates a new key in the Keychain, and keeps the file when the Keychain refuses", async () => {
    const a = fakeKeychain();
    const envA: Env = { DAILY_BRIEF_KEYCHAIN: "1" };
    await loadSecrets(a.kc, envA);
    expect(Buffer.from(a.items.get("TOKEN_ENCRYPTION_KEY")!, "base64")).toHaveLength(32);

    const b = fakeKeychain({}, false);
    mkdirSync(join(dir, ".daily-brief"), { recursive: true });
    writeFileSync(keyFile(), KEY);
    const envB: Env = { DAILY_BRIEF_KEYCHAIN: "1" };
    expect((await loadSecrets(b.kc, envB)).TOKEN_ENCRYPTION_KEY).toBe("file");
    expect(envB.TOKEN_ENCRYPTION_KEY).toBe(KEY);
    expect(readFileSync(keyFile(), "utf8")).toBe(KEY);
  });
});

describe("loadSecrets in dev", () => {
  it("keeps .env values and the key file, and falls back to the Keychain only when both are missing", async () => {
    const { kc } = fakeKeychain({ ANTHROPIC_API_KEY: "sk-ant-kc", TOKEN_ENCRYPTION_KEY: KEY });
    const env: Env = { ANTHROPIC_API_KEY: "sk-ant-env" };
    mkdirSync(join(dir, ".daily-brief"), { recursive: true });
    writeFileSync(keyFile(), "file-key");
    expect(await loadSecrets(kc, env)).toEqual({ ANTHROPIC_API_KEY: "env" });
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-env");
    expect(env.TOKEN_ENCRYPTION_KEY).toBeUndefined(); // the store reads the file, as before

    const env2: Env = {};
    const dir2 = mkdtempSync(join(tmpdir(), "db-secrets-"));
    process.env.DAILY_BRIEF_DIR = dir2;
    expect(await loadSecrets(kc, env2)).toEqual({ ANTHROPIC_API_KEY: "keychain", TOKEN_ENCRYPTION_KEY: "keychain" });
    expect(env2.TOKEN_ENCRYPTION_KEY).toBe(KEY);
  });

  it("does nothing on a system without a Keychain", async () => {
    const kc: Keychain = { available: () => false, read: async () => "x", write: async () => true };
    const env: Env = { DAILY_BRIEF_KEYCHAIN: "1" };
    expect(await loadSecrets(kc, env)).toEqual({});
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});
