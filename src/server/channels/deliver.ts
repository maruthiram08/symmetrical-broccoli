import { briefDigest, wrapDigest, weekDigest } from "@/lib/channels/digest";
import { renderDigestEmail } from "@/lib/email/digest";
import { renderEmail } from "@/lib/email/render";
import type { WeekModel } from "@/lib/brief/week";
import type { WrapModel } from "@/lib/brief/wrap";
import type { BriefModel } from "@/lib/types";
import { logJobError } from "@/server/jobs/types";
import type { Store } from "@/server/store";
import { CHANNEL_IDS, MESSAGE_KINDS, setStatus, type ChannelConfigStore, type ChannelId, type MessageKind } from "./config";
import { ChannelError } from "./http";
import { sendOn, type Outbound, type SendEnv } from "./senders";

export interface ChannelDeps {
  config: ChannelConfigStore;
  env: SendEnv;
  store: Pick<Store, "logEvent">;
  now: () => Date;
}

export type Bundle = Partial<Record<MessageKind, Outbound>>;

export interface ChannelSendResult {
  channel: ChannelId;
  kind: MessageKind;
  status: "sent" | "already_sent" | "failed";
  error?: string;
}

/** The messages for one delivery: the brief always, the wrap and the recap when given. */
export function buildBundle(a: { model: BriefModel; wrap?: WrapModel; week?: WeekModel; link: string }): Bundle {
  const links = { base: a.link, itemUrl: (id: string) => `${a.link}/item/${encodeURIComponent(id)}` };
  const out: Bundle = { brief: { digest: briefDigest(a.model), email: renderEmail(a.model, links) } };
  if (a.wrap) {
    const d = wrapDigest(a.wrap);
    out.wrap = { digest: d, email: renderDigestEmail(d, a.link) };
  }
  if (a.week) {
    const d = weekDigest(a.week);
    out.week = { digest: d, email: renderDigestEmail(d, a.link) };
  }
  return out;
}

/** A short reason for Health: our own ChannelError text, or just the error's name. */
export function failureText(e: unknown): string {
  if (e instanceof ChannelError) return e.message;
  return e instanceof Error ? e.name : "Error";
}

/**
 * Send each message to every channel that is on and wants that kind. Channels run side by side and
 * each failure stays in its channel: it is recorded on the channel (Settings and Health show it),
 * logged with secrets removed, and never stops another channel or the brief itself. A message that
 * already went out for the date is not sent again (say, after a retry of the delivery).
 */
export async function fanOut(deps: ChannelDeps, userId: string, date: string, bundle: Bundle): Promise<ChannelSendResult[]> {
  const file = deps.config.read();
  const work = CHANNEL_IDS.filter((id) => file[id].enabled).map(async (id) => {
    const out: ChannelSendResult[] = [];
    for (const kind of MESSAGE_KINDS) {
      const msg = bundle[kind];
      if (!msg || !file[id].kinds[kind]) continue;
      const key = `${id}:${kind}:${date}`;
      if (deps.config.read().sent.includes(key)) {
        out.push({ channel: id, kind, status: "already_sent" });
        continue;
      }
      try {
        const ref = await sendOn(id, file, msg, deps.env);
        const at = deps.now().toISOString();
        deps.config.update((c) => {
          c.sent.push(key);
          setStatus(c, id, { lastOkAt: at });
          if (id === "telegram" && kind === "brief") c.telegramState.numbers = { date, itemIds: msg.digest.numbers };
        });
        await deps.store.logEvent({ userId, type: "channel_sent", payload: { channel: id, kind, date, ref: String(ref).slice(0, 80) } }).catch(() => undefined);
        out.push({ channel: id, kind, status: "sent" });
      } catch (e) {
        const error = failureText(e);
        deps.config.update((c) => setStatus(c, id, { lastErrorAt: deps.now().toISOString(), lastError: `${kind}: ${error}` }));
        await logJobError(deps, userId, id, e instanceof ChannelError ? e : new ChannelError(error), { kind, date });
        out.push({ channel: id, kind, status: "failed", error });
      }
    }
    return out;
  });
  return (await Promise.all(work)).flat();
}
