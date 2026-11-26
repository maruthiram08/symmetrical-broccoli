import { loadBriefData } from "@/lib/brief/data";
import { buildWeek } from "@/lib/brief/week";
import { buildWrap } from "@/lib/brief/wrap";
import { buildBrief } from "@/lib/brief/build";
import type { BriefModel, User } from "@/lib/types";
import { logJobError } from "@/server/jobs/types";
import type { Store } from "@/server/store";
import { getStore, me } from "@/server/local/app";
import { appUrl } from "@/server/local/paths";
import { fileChannelStore, setStatus, type ChannelConfigStore, type ChannelId, type MessageKind } from "./config";
import { buildBundle, failureText, fanOut, type ChannelDeps, type ChannelSendResult } from "./deliver";
import { pollTelegramReplies } from "./replies";
import { defaultSecrets, type SecretStore } from "./secrets";
import { realSmtp, sendOn, type SendEnv } from "./senders";

// The app's wiring for channels: the real config file, the Keychain, fetch and SMTP.

const g = globalThis as unknown as { __dbChannels?: { config: ChannelConfigStore; secrets: SecretStore } };

export function channelConfig(): ChannelConfigStore {
  return (g.__dbChannels ??= { config: fileChannelStore(), secrets: defaultSecrets() }).config;
}
export function channelSecrets(): SecretStore {
  return (g.__dbChannels ??= { config: fileChannelStore(), secrets: defaultSecrets() }).secrets;
}

export function sendEnv(): SendEnv {
  return { fetch: (url, init) => fetch(url, init), secrets: channelSecrets(), smtp: realSmtp, link: appUrl() };
}

export function channelDeps(store: Pick<Store, "logEvent"> = getStore()): ChannelDeps {
  return { config: channelConfig(), env: sendEnv(), store, now: () => new Date() };
}

/**
 * After the note is written: send the brief, the evening wrap and (on Fridays) the recap to the
 * channels that want them. Never throws, so a channel can't stop the brief from being marked sent.
 */
export async function publishChannels(store: Store, user: User, model: BriefModel, opts: { recap: boolean; now?: Date }): Promise<ChannelSendResult[]> {
  try {
    const file = channelConfig().read();
    const on = (k: MessageKind) => (["email", "slack", "telegram", "whatsapp"] as ChannelId[]).some((id) => file[id].enabled && file[id].kinds[k]);
    if (!on("brief") && !on("wrap") && !on("week")) return [];
    const now = opts.now ?? new Date();
    const data = on("wrap") || (opts.recap && on("week")) ? await loadBriefData(store, user.id) : null;
    const bundle = buildBundle({
      model,
      wrap: data && on("wrap") ? buildWrap(data, now, user.timeZone) : undefined,
      week: data && opts.recap && on("week") ? buildWeek(data, now, user.timeZone) : undefined,
      link: appUrl(),
    });
    return await fanOut(channelDeps(store), user.id, model.date, bundle);
  } catch (e) {
    await logJobError({ store }, user.id, "channels", e);
    return [];
  }
}

/** Settings › Send test: today's brief (or wrap, or recap) as it stands now, marked "Test". */
export async function sendTest(id: ChannelId, kind: MessageKind = "brief"): Promise<{ ok: boolean; error: string | null }> {
  const user = await me();
  if (!user) return { ok: false, error: "Set up the app first" };
  const store = getStore();
  const now = new Date();
  const config = channelConfig();
  try {
    const model = await buildBrief(store, user, now);
    const data = kind === "brief" ? null : await loadBriefData(store, user.id);
    const bundle = buildBundle({
      model,
      wrap: kind === "wrap" ? buildWrap(data!, now, user.timeZone) : undefined,
      week: kind === "week" ? buildWeek(data!, now, user.timeZone) : undefined,
      link: appUrl(),
    });
    const msg = bundle[kind]!;
    await sendOn(id, config.read(), { ...msg, prefix: "Test · " }, sendEnv());
    config.update((c) => setStatus(c, id, { lastOkAt: now.toISOString(), lastTestAt: now.toISOString() }));
    return { ok: true, error: null };
  } catch (e) {
    const error = failureText(e);
    config.update((c) => setStatus(c, id, { lastErrorAt: now.toISOString(), lastError: `test: ${error}`, lastTestAt: now.toISOString() }));
    await logJobError({ store }, user.id, id, e, { kind: "test" });
    return { ok: false, error };
  }
}

/** Scheduler tick: read Telegram "/done 3" replies (every 5 minutes, only when turned on). */
export async function pollRepliesLocal(): Promise<void> {
  const user = await me();
  if (!user) return;
  await pollTelegramReplies({ config: channelConfig(), env: sendEnv(), store: getStore(), now: () => new Date() }, user.id);
}
