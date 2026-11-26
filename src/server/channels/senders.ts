import { slackMessage } from "@/lib/channels/slack";
import { telegramText } from "@/lib/channels/telegram";
import { whatsappTemplate } from "@/lib/channels/whatsapp";
import type { Digest } from "@/lib/channels/digest";
import type { RenderedEmail } from "@/lib/email/render";
import type { ChannelId, ChannelsFile, EmailConfig, SlackConfig, TelegramConfig, WhatsAppConfig } from "./config";
import { callJson, ChannelError, safeCode, type Fetch } from "./http";
import type { SecretStore } from "./secrets";

/** One message, ready for any channel: the digest, plus the rich email when there is one. */
export interface Outbound {
  digest: Digest;
  email: RenderedEmail;
  /** "Test · " for Send test. */
  prefix?: string;
}

export interface SmtpOptions {
  host: string;
  port: number;
  secure: boolean;
  requireTLS: boolean;
  auth: { user: string; pass: string };
}
export type SmtpFactory = (o: SmtpOptions) => { sendMail(m: Record<string, unknown>): Promise<{ messageId?: string }> };

export interface SendEnv {
  fetch: Fetch;
  secrets: SecretStore;
  smtp: SmtpFactory;
  /** The link a message carries (your Mac's address unless you set another). */
  link: string;
}

type Nodemailer = typeof import("nodemailer");

/**
 * nodemailer, loaded when an email is sent. It is kept out of the bundle (webpackIgnore, and
 * serverExternalPackages in next.config.ts): Next also compiles the scheduler for the edge runtime,
 * where nodemailer's bare require("stream") can't resolve.
 */
async function loadNodemailer(): Promise<Nodemailer> {
  const m = (await import(/* webpackIgnore: true */ "nodemailer")) as Nodemailer & { default?: Nodemailer };
  return m.default ?? m;
}

export const realSmtp: SmtpFactory = (o) => ({
  async sendMail(m) {
    const nodemailer = await loadNodemailer();
    return nodemailer.createTransport({ ...o, connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000 }).sendMail(m);
  },
});

const EMAIL_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

async function need(secrets: SecretStore, name: Parameters<SecretStore["get"]>[0], what: string): Promise<string> {
  const v = await secrets.get(name);
  if (!v) throw new ChannelError(`${what} isn't saved yet`);
  return v;
}

export async function sendEmail(cfg: EmailConfig, msg: Outbound, env: SendEnv): Promise<string> {
  if (!EMAIL_RE.test(cfg.to)) throw new ChannelError("Add the address to send to");
  const subject = `${msg.prefix ?? ""}${msg.email.subject}`;
  if (cfg.provider === "resend") {
    if (!EMAIL_RE.test(cfg.from.replace(/^.*<([^>]+)>\s*$/, "$1"))) throw new ChannelError("Add a From address on a domain you verified in Resend");
    const key = await need(env.secrets, "resendKey", "The Resend API key");
    const r = (await callJson(env.fetch, "https://api.resend.com/emails", {
      service: "Resend",
      headers: { authorization: `Bearer ${key}` },
      body: { from: cfg.from, to: [cfg.to], subject, html: msg.email.html, text: msg.email.text },
      errorCode: (j) => {
        const o = j as { id?: unknown; name?: unknown } | null;
        return o && typeof o === "object" && !o.id ? safeCode(o.name ?? null) : null;
      },
    })) as { id?: string };
    return r?.id ?? "resend";
  }
  if (!cfg.smtpHost || !cfg.smtpUser) throw new ChannelError("Add the SMTP server and user name");
  const pass = (await need(env.secrets, "smtpPassword", "The SMTP password")).replace(/\s+/g, "");
  try {
    const transport = env.smtp({
      host: cfg.smtpHost,
      port: cfg.smtpPort,
      secure: cfg.smtpSecurity === "tls",
      requireTLS: cfg.smtpSecurity === "starttls",
      auth: { user: cfg.smtpUser, pass },
    });
    const info = await transport.sendMail({
      from: cfg.from || cfg.smtpUser,
      to: cfg.to,
      subject,
      html: msg.email.html,
      text: msg.email.text,
    });
    return info.messageId ?? "smtp";
  } catch (e) {
    // nodemailer errors carry codes like EAUTH or ECONNECTION and the server's reply; keep only the code.
    const code = safeCode((e as { code?: unknown; responseCode?: unknown }).code ?? null);
    const rc = (e as { responseCode?: unknown }).responseCode;
    const why = code === "EAUTH" ? " (check the user name and app password)"
      : code === "ESOCKET" || code === "ECONNECTION" || code === "ETIMEDOUT" || code === "EDNS" ? " (couldn't reach the server; check the server and port)"
      : "";
    throw new ChannelError(`SMTP ${code ?? "error"}${typeof rc === "number" ? ` ${rc}` : ""}${why}`);
  }
}

const slackError = (j: unknown) => {
  const o = j as { ok?: boolean; error?: unknown } | null;
  return o && typeof o === "object" && o.ok === false ? safeCode(o.error) ?? "error" : null;
};

/**
 * Slack Web API call with a token. Throws on HTTP errors and on {ok:false}. chat.postMessage goes as
 * JSON (for blocks); the read methods only take form fields, so everything else goes form-encoded.
 */
export async function slackApi(fetchFn: Fetch, token: string, method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const json = method === "chat.postMessage";
  const form = json ? undefined : Object.fromEntries(Object.entries(body).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
  return (await callJson(fetchFn, `https://slack.com/api/${method}`, {
    service: "Slack",
    headers: { authorization: `Bearer ${token}` },
    ...(json ? { body } : { form }),
    errorCode: slackError,
  })) as Record<string, unknown>;
}

export async function sendSlack(cfg: SlackConfig, msg: Outbound, env: SendEnv): Promise<string> {
  const m = slackMessage(msg.digest, { link: env.link, prefix: msg.prefix });
  if (cfg.mode === "webhook") {
    const url = await need(env.secrets, "slackWebhook", "The webhook URL");
    if (!/^https:\/\/hooks\.slack\.com\/services\//.test(url)) throw new ChannelError("The webhook URL should start with https://hooks.slack.com/services/");
    await callJson(env.fetch, url, { service: "Slack webhook", body: m });
    return "webhook";
  }
  if (!/^[UW][A-Z0-9]{6,}$/.test(cfg.userId)) throw new ChannelError("Add your Slack member ID (starts with U)");
  const token = await need(env.secrets, "slackBot", "The bot token");
  // Posting to a user ID lands in your DM with the app.
  const r = await slackApi(env.fetch, token, "chat.postMessage", { channel: cfg.userId, unfurl_links: false, ...m });
  return String(r.ts ?? "slack");
}

const telegramError = (j: unknown) => {
  const o = j as { ok?: boolean; error_code?: unknown } | null;
  return o && typeof o === "object" && o.ok === false ? safeCode(o.error_code) ?? "error" : null;
};

export async function telegramApi(fetchFn: Fetch, token: string, method: string, body?: Record<string, unknown>): Promise<unknown> {
  if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token)) throw new ChannelError("The bot token doesn't look right (it's like 123456:ABC…)");
  const r = (await callJson(fetchFn, `https://api.telegram.org/bot${token}/${method}`, { service: "Telegram", body, errorCode: telegramError })) as { result?: unknown };
  return r?.result;
}

export async function sendTelegram(cfg: TelegramConfig, msg: Outbound, env: SendEnv): Promise<string> {
  if (!/^-?\d{3,}$/.test(cfg.chatId.trim())) throw new ChannelError("Add your chat ID (a number)");
  const token = await need(env.secrets, "telegramBot", "The bot token");
  const text = telegramText(msg.digest, { replies: cfg.replies, link: env.link, prefix: msg.prefix });
  const r = (await telegramApi(env.fetch, token, "sendMessage", {
    chat_id: cfg.chatId.trim(),
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  })) as { message_id?: number } | undefined;
  return String(r?.message_id ?? "telegram");
}

export const WHATSAPP_API = "https://graph.facebook.com/v21.0";

export async function sendWhatsApp(cfg: WhatsAppConfig, msg: Outbound, env: SendEnv): Promise<string> {
  if (!/^\d{6,}$/.test(cfg.phoneNumberId.trim())) throw new ChannelError("Add the phone number ID from WhatsApp Manager");
  if (!/^\d{8,15}$/.test(cfg.to.replace(/[^\d]/g, ""))) throw new ChannelError("Add your WhatsApp number with the country code");
  if (!/^[a-z0-9_]{1,512}$/.test(cfg.template)) throw new ChannelError("The template name uses lower case letters, digits and _");
  const token = await need(env.secrets, "whatsappToken", "The access token");
  const d = msg.prefix ? { ...msg.digest, title: `${msg.prefix}${msg.digest.title}` } : msg.digest;
  const r = (await callJson(env.fetch, `${WHATSAPP_API}/${cfg.phoneNumberId.trim()}/messages`, {
    service: "WhatsApp",
    headers: { authorization: `Bearer ${token}` },
    body: whatsappTemplate(d, { ...cfg, link: cfg.link || env.link }),
    errorCode: (j) => safeCode((j as { error?: { code?: unknown } } | null)?.error?.code ?? null),
  })) as { messages?: Array<{ id?: string }> };
  return r?.messages?.[0]?.id ?? "whatsapp";
}

export function senderFor(id: ChannelId): (cfg: never, msg: Outbound, env: SendEnv) => Promise<string> {
  return ({ email: sendEmail, slack: sendSlack, telegram: sendTelegram, whatsapp: sendWhatsApp } as const)[id] as never;
}

/** Send one message on one channel with its current settings. */
export function sendOn(id: ChannelId, file: ChannelsFile, msg: Outbound, env: SendEnv): Promise<string> {
  return senderFor(id)(file[id] as never, msg, env);
}
