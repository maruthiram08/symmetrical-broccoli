import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { macKeychain, type Keychain } from "@/server/local/keychain";
import { dataDir } from "@/server/local/paths";

/** Every secret a channel can hold. Never logged, never written to channels.json. */
export const CHANNEL_SECRETS = {
  smtpPassword: "CHANNEL_EMAIL_SMTP_PASSWORD",
  resendKey: "CHANNEL_EMAIL_RESEND_KEY",
  slackBot: "CHANNEL_SLACK_BOT_TOKEN",
  slackUser: "CHANNEL_SLACK_USER_TOKEN",
  slackWebhook: "CHANNEL_SLACK_WEBHOOK_URL",
  telegramBot: "CHANNEL_TELEGRAM_BOT_TOKEN",
  whatsappToken: "CHANNEL_WHATSAPP_TOKEN",
} as const;
export type ChannelSecret = keyof typeof CHANNEL_SECRETS;

export interface SecretStore {
  /** "keychain" on a Mac; "file" elsewhere (development on Linux). */
  where: "keychain" | "file" | "memory";
  get(name: ChannelSecret): Promise<string | null>;
  set(name: ChannelSecret, value: string): Promise<boolean>;
  remove(name: ChannelSecret): Promise<boolean>;
}

// The Keychain helper only takes [A-Za-z0-9+/=_.-] values (it refuses to quote anything else), so a
// webhook URL or an app password with spaces is stored base64url-encoded.
const enc = (v: string) => Buffer.from(v, "utf8").toString("base64url").padEnd(8, "=");
const dec = (v: string) => Buffer.from(v.replace(/=+$/, ""), "base64url").toString("utf8");

export function keychainSecrets(kc: Keychain = macKeychain): SecretStore {
  return {
    where: "keychain",
    async get(name) {
      const v = await kc.read(CHANNEL_SECRETS[name]);
      return v ? dec(v) : null;
    },
    set: (name, value) => kc.write(CHANNEL_SECRETS[name], enc(value)),
    remove: async (name) => (kc.remove ? kc.remove(CHANNEL_SECRETS[name]) : false),
  };
}

/** Off a Mac there is no Keychain: a 0600 file next to the data, never committed, never logged. */
export function fileSecrets(path: string = join(dataDir(), "channel-secrets.json")): SecretStore {
  const read = (): Record<string, string> => {
    try {
      return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, string>) : {};
    } catch {
      return {};
    }
  };
  const write = (o: Record<string, string>) => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(o), { mode: 0o600 });
    renameSync(tmp, path);
  };
  return {
    where: "file",
    get: async (name) => read()[name] ?? null,
    async set(name, value) {
      write({ ...read(), [name]: value });
      return true;
    },
    async remove(name) {
      const o = read();
      delete o[name];
      write(o);
      return true;
    },
  };
}

export function memorySecrets(initial: Partial<Record<ChannelSecret, string>> = {}): SecretStore & { data: Partial<Record<ChannelSecret, string>> } {
  const data = { ...initial };
  return {
    where: "memory",
    data,
    get: async (n) => data[n] ?? null,
    set: async (n, v) => { data[n] = v; return true; },
    remove: async (n) => { delete data[n]; return true; },
  };
}

/** The Keychain on a Mac, the 0600 file anywhere else. */
export function defaultSecrets(kc: Keychain = macKeychain): SecretStore {
  return kc.available() ? keychainSecrets(kc) : fileSecrets();
}
