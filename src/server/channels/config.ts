import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDir } from "@/server/local/paths";

// Where the brief goes besides the note on this Mac. Non-secret settings and delivery state live in
// <data>/channels.json (0600); tokens and passwords live in the Keychain (secrets.ts). All off by default.

export const CHANNEL_IDS = ["email", "slack", "telegram", "whatsapp"] as const;
export type ChannelId = (typeof CHANNEL_IDS)[number];

/** What a channel can receive: the daily brief, the short evening wrap, the Friday recap. */
export const MESSAGE_KINDS = ["brief", "wrap", "week"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];
export type Kinds = Record<MessageKind, boolean>;

export const CHANNEL_LABEL: Record<ChannelId, string> = { email: "Email", slack: "Slack", telegram: "Telegram", whatsapp: "WhatsApp" };
export const KIND_LABEL: Record<MessageKind, string> = { brief: "Daily brief", wrap: "Evening wrap", week: "Friday recap" };

export interface EmailConfig {
  enabled: boolean;
  kinds: Kinds;
  provider: "smtp" | "resend";
  to: string;
  from: string;
  smtpHost: string;
  smtpPort: number;
  /** "starttls" on 587, "tls" on 465. */
  smtpSecurity: "starttls" | "tls";
  smtpUser: string;
}

export interface SlackConfig {
  enabled: boolean;
  kinds: Kinds;
  /** "bot": a bot token DMs you (and can send nudges). "webhook": an incoming webhook posts to one channel. */
  mode: "bot" | "webhook";
  /** Your Slack member id (U…), the DM target for the brief. */
  userId: string;
}

export interface TelegramConfig {
  enabled: boolean;
  kinds: Kinds;
  chatId: string;
  /** Read "/done 3" replies with getUpdates every 5 minutes. Off by default. */
  replies: boolean;
}

export interface WhatsAppConfig {
  enabled: boolean;
  kinds: Kinds;
  phoneNumberId: string;
  /** Your number, international format without + (e.g. 919812345678). */
  to: string;
  template: string;
  language: string;
  /** The link in the message. The app runs on your Mac, so this is whatever you can open from your phone. */
  link: string;
}

export interface ChannelStatus {
  lastOkAt: string | null;
  lastErrorAt: string | null;
  /** Short, redacted: "HTTP 401 invalid_auth". */
  lastError: string | null;
  lastTestAt: string | null;
}

export interface ChannelsFile {
  email: EmailConfig;
  slack: SlackConfig;
  telegram: TelegramConfig;
  whatsapp: WhatsAppConfig;
  /** Which secrets are stored, so Settings can say "saved" without reading the Keychain. */
  secretsSet: string[];
  status: Partial<Record<ChannelId, ChannelStatus>>;
  /** "email:brief:2026-11-25" for every send that went out; stops a second send after a retry. */
  sent: string[];
  telegramState: {
    offset: number;
    lastPollAt: string | null;
    /** The numbers in the last brief sent to Telegram, so "/done 3" knows which item 3 is. */
    numbers: { date: string; itemIds: string[] } | null;
  };
}

const DEFAULT_KINDS: Kinds = { brief: true, wrap: false, week: true };

export function defaultChannels(): ChannelsFile {
  return {
    email: { enabled: false, kinds: { ...DEFAULT_KINDS }, provider: "smtp", to: "", from: "", smtpHost: "smtp.gmail.com", smtpPort: 587, smtpSecurity: "starttls", smtpUser: "" },
    slack: { enabled: false, kinds: { ...DEFAULT_KINDS }, mode: "bot", userId: "" },
    telegram: { enabled: false, kinds: { ...DEFAULT_KINDS }, chatId: "", replies: false },
    whatsapp: { enabled: false, kinds: { brief: true, wrap: false, week: false }, phoneNumberId: "", to: "", template: "daily_brief", language: "en", link: "" },
    secretsSet: [],
    status: {},
    sent: [],
    telegramState: { offset: 0, lastPollAt: null, numbers: null },
  };
}

/** Keep the sent log short: two months of four channels and three kinds is plenty. */
const SENT_KEEP = 400;

export interface ChannelConfigStore {
  read(): ChannelsFile;
  /** Read, change, write back. Returns what fn returned. */
  update<T>(fn: (c: ChannelsFile) => T): T;
}

function merge(raw: Partial<ChannelsFile>): ChannelsFile {
  const d = defaultChannels();
  const ch = <K extends ChannelId>(k: K) => ({ ...d[k], ...(raw[k] ?? {}), kinds: { ...d[k].kinds, ...(raw[k]?.kinds ?? {}) } }) as ChannelsFile[K];
  return {
    email: ch("email"),
    slack: ch("slack"),
    telegram: ch("telegram"),
    whatsapp: ch("whatsapp"),
    secretsSet: Array.isArray(raw.secretsSet) ? raw.secretsSet : [],
    status: raw.status ?? {},
    sent: Array.isArray(raw.sent) ? raw.sent : [],
    telegramState: { ...d.telegramState, ...(raw.telegramState ?? {}) },
  };
}

/** channels.json, written whole through a temp file and rename (never half-written). */
export function fileChannelStore(path: string = join(dataDir(), "channels.json")): ChannelConfigStore {
  const read = (): ChannelsFile => {
    if (!existsSync(path)) return defaultChannels();
    try {
      return merge(JSON.parse(readFileSync(path, "utf8")) as Partial<ChannelsFile>);
    } catch {
      return defaultChannels();
    }
  };
  return {
    read,
    update(fn) {
      const c = read();
      const out = fn(c);
      c.sent = c.sent.slice(-SENT_KEEP);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const tmp = `${path}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(c, null, 2), { mode: 0o600 });
      renameSync(tmp, path);
      return out;
    },
  };
}

/** In memory, for tests. */
export function memoryChannelStore(initial: Partial<ChannelsFile> = {}): ChannelConfigStore & { data: ChannelsFile } {
  const s = { data: merge(structuredClone(initial)) } as ChannelConfigStore & { data: ChannelsFile };
  s.read = () => structuredClone(s.data);
  s.update = (fn) => {
    const c = structuredClone(s.data);
    const out = fn(c);
    c.sent = c.sent.slice(-SENT_KEEP);
    s.data = c;
    return out;
  };
  return s;
}

export function setStatus(c: ChannelsFile, id: ChannelId, patch: Partial<ChannelStatus>): void {
  c.status[id] = { lastOkAt: null, lastErrorAt: null, lastError: null, lastTestAt: null, ...c.status[id], ...patch };
}
