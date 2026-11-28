"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { CHANNEL_IDS, MESSAGE_KINDS, type ChannelId, type ChannelsFile, type MessageKind } from "@/server/channels/config";
import { failureText } from "@/server/channels/deliver";
import { channelConfig, channelSecrets, sendEnv, sendTest } from "@/server/channels/local";
import { findMemberByEmail, findMembers, nudgeText, nudgesReady, postDm, signConfirm, spendConfirm, type Confirm, type SlackMember } from "@/server/channels/nudge";
import type { ChannelSecret } from "@/server/channels/secrets";
import { getAiStore } from "@/server/local/ai-store";
import { getStore, me } from "@/server/local/app";
import { logJobError } from "@/server/jobs/types";

/** Which secret fields each channel's form may set. */
const SECRET_FIELDS: Record<ChannelId, ChannelSecret[]> = {
  email: ["smtpPassword", "resendKey"],
  slack: ["slackBot", "slackUser", "slackWebhook"],
  telegram: ["telegramBot"],
  whatsapp: ["whatsappToken"],
};

const str = (max: number) => z.string().trim().max(max).default("");
const channelSchema = z.enum(CHANNEL_IDS);

const fieldSchemas = {
  email: z.object({
    provider: z.enum(["smtp", "resend"]).default("smtp"),
    to: str(200), from: str(200), smtpHost: str(200), smtpUser: str(200),
    smtpPort: z.coerce.number().int().min(1).max(65535).default(587),
    smtpSecurity: z.enum(["starttls", "tls"]).default("starttls"),
  }),
  slack: z.object({ mode: z.enum(["bot", "webhook"]).default("bot"), userId: str(40) }),
  telegram: z.object({ chatId: str(40), replies: z.boolean().default(false) }),
  whatsapp: z.object({ phoneNumberId: str(40), to: str(40), template: str(120), language: str(20), link: str(300) }),
} as const;

const back = (id: ChannelId, q: string) => redirect(`/setup?ch=${id}&${q}#ch-${id}`);

function fields(form: FormData): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const [k, v] of form.entries()) if (typeof v === "string") o[k] = v;
  o.replies = form.get("replies") === "on";
  return o;
}

/** Write one channel's form into channels.json and the Keychain. Blank secret fields keep what is saved. */
async function applyChannelForm(ch: ChannelId, form: FormData): Promise<"form" | "keychain" | null> {
  const parsed = fieldSchemas[ch].safeParse(fields(form));
  if (!parsed.success) return "form";
  const secrets = channelSecrets();
  const stored: ChannelSecret[] = [];
  for (const name of SECRET_FIELDS[ch]) {
    const v = String(form.get(name) ?? "").trim();
    if (!v) continue;
    if (v.length > 600) return "form";
    if (!(await secrets.set(name, v))) return "keychain";
    stored.push(name);
  }
  const kinds = Object.fromEntries(MESSAGE_KINDS.map((k) => [k, form.get(`kind_${k}`) === "on"])) as Record<MessageKind, boolean>;
  channelConfig().update((c) => {
    Object.assign(c[ch], parsed.data, { enabled: form.get("enabled") === "on", kinds });
    c.secretsSet = [...new Set([...c.secretsSet, ...stored])];
  });
  return null;
}

/** Settings › Delivery › Save for one channel. */
export async function saveChannel(form: FormData): Promise<void> {
  const id = channelSchema.safeParse(form.get("channel"));
  if (!id.success) redirect("/setup");
  const err = await applyChannelForm(id.data, form);
  revalidatePath("/setup");
  back(id.data, err ? `err=${err}` : "saved=1");
}

/** Remove one saved secret (the Keychain item goes too). */
export async function removeChannelSecret(form: FormData): Promise<void> {
  const id = channelSchema.safeParse(form.get("channel"));
  if (!id.success) redirect("/setup");
  const name = String(form.get("secret") ?? "") as ChannelSecret;
  if (!SECRET_FIELDS[id.data].includes(name)) back(id.data, "err=form");
  await channelSecrets().remove(name);
  channelConfig().update((c) => { c.secretsSet = c.secretsSet.filter((s) => s !== name); });
  revalidatePath("/setup");
  back(id.data, "removed=1");
}

/** Send test: saves the form, then sends today's brief as it stands, marked "Test". */
export async function testChannel(form: FormData): Promise<void> {
  const id = channelSchema.safeParse(form.get("channel"));
  if (!id.success) redirect("/setup");
  const err = await applyChannelForm(id.data, form);
  if (err) back(id.data, `err=${err}`);
  const kind = z.enum(MESSAGE_KINDS).catch("brief").parse(form.get("testKind") ?? "brief");
  const r = await sendTest(id.data, kind);
  revalidatePath("/setup");
  back(id.data, r.ok ? "test=ok" : "test=fail");
}

// ---- nudges ----

export interface NudgeCandidate extends SlackMember, Confirm {}

export type NudgePrep =
  | { ok: true; text: string; asUser: boolean; candidates: NudgeCandidate[]; person: string | null }
  | { ok: false; error: string };

async function nudgeContext(itemId: string): Promise<{ draft: string; person: string | null; token: string; asUser: boolean; name: string } | { error: string }> {
  const user = await me();
  if (!user) return { error: "Set up the app first." };
  const file: ChannelsFile = channelConfig().read();
  if (!nudgesReady(file)) return { error: "Slack isn't set up for nudges. Add a bot token in Settings." };
  const item = (await getStore().listItems(user.id)).find((i) => i.id === itemId && i.kind === "waiting");
  const draft = getAiStore().nudges().find((n) => n.itemId === itemId)?.text;
  if (!item || !draft) return { error: "This nudge isn't there any more." };
  const secrets = channelSecrets();
  const userToken = await secrets.get("slackUser");
  const token = userToken ?? (await secrets.get("slackBot"));
  if (!token) return { error: "The Slack token isn't saved. Add it in Settings." };
  return { draft, person: item.person, token, asUser: !!userToken, name: user.name };
}

const itemIdSchema = z.string().min(1).max(100);

/** Step one: who would get it and the exact text. Sends nothing. */
export async function prepareNudge(itemId: string): Promise<NudgePrep> {
  const id = itemIdSchema.safeParse(itemId);
  if (!id.success) return { ok: false, error: "This nudge isn't there any more." };
  const ctx = await nudgeContext(id.data);
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const text = nudgeText(ctx.draft, ctx.asUser, ctx.name);
  try {
    const found = ctx.person ? await findMembers(sendEnv().fetch, ctx.token, ctx.person) : [];
    const now = Date.now();
    return { ok: true, text, asUser: ctx.asUser, person: ctx.person, candidates: found.map((m) => ({ ...m, ...signConfirm(id.data, m.id, text, now) })) };
  } catch (e) {
    return { ok: false, error: `Couldn't look up Slack members: ${failureText(e)}` };
  }
}

/** When the name matched nobody: look the person up by their Slack email. */
export async function findNudgeRecipient(itemId: string, email: string): Promise<NudgePrep> {
  const id = itemIdSchema.safeParse(itemId);
  const mail = z.string().trim().email().max(200).safeParse(email);
  if (!id.success || !mail.success) return { ok: false, error: "Type their Slack email address." };
  const ctx = await nudgeContext(id.data);
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const text = nudgeText(ctx.draft, ctx.asUser, ctx.name);
  try {
    const m = await findMemberByEmail(sendEnv().fetch, ctx.token, mail.data);
    if (!m) return { ok: false, error: "No one in your Slack has that email." };
    return { ok: true, text, asUser: ctx.asUser, person: ctx.person, candidates: [{ ...m, ...signConfirm(id.data, m.id, text, Date.now()) }] };
  } catch (e) {
    return { ok: false, error: `Couldn't look up Slack members: ${failureText(e)}` };
  }
}

const sendSchema = z.object({ itemId: itemIdSchema, memberId: z.string().regex(/^[UW][A-Z0-9]{2,}$/), exp: z.number(), sig: z.string().min(10).max(100), confirmed: z.literal(true) });

/**
 * Step two, only from the confirm dialog: send the text that dialog showed to the member it showed.
 * The text is the stored draft (never taken from the page), and the signed confirmation works once.
 */
export async function sendNudge(input: { itemId: string; memberId: string; exp: number; sig: string; confirmed: true }): Promise<{ ok: boolean; message: string }> {
  const p = sendSchema.safeParse(input);
  if (!p.success) return { ok: false, message: "Confirm the recipient and text first." };
  const ctx = await nudgeContext(p.data.itemId);
  if ("error" in ctx) return { ok: false, message: ctx.error };
  const text = nudgeText(ctx.draft, ctx.asUser, ctx.name);
  if (!spendConfirm(p.data.itemId, p.data.memberId, text, { exp: p.data.exp, sig: p.data.sig }, Date.now())) {
    return { ok: false, message: "That confirmation expired or the draft changed. Open it again." };
  }
  const user = (await me())!;
  try {
    await postDm(sendEnv().fetch, ctx.token, p.data.memberId, text);
    await getStore().logEvent({ userId: user.id, type: "handoff", payload: { itemId: p.data.itemId, target: "slack", how: "sent" } });
    await getStore().logEvent({ userId: user.id, type: "nudge_sent", payload: { itemId: p.data.itemId, channel: "slack" } });
    return { ok: true, message: "Sent on Slack." };
  } catch (e) {
    await logJobError({ store: getStore() }, user.id, "slack", e, { kind: "nudge" });
    return { ok: false, message: `Not sent: ${failureText(e)}` };
  }
}
