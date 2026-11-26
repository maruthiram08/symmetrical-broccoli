import { parseDone, tgEscape } from "@/lib/channels/telegram";
import type { Item } from "@/lib/types";
import { logJobError } from "@/server/jobs/types";
import type { Store } from "@/server/store";
import { setStatus, type ChannelConfigStore } from "./config";
import { failureText } from "./deliver";
import { telegramApi, type SendEnv } from "./senders";

/** How often Telegram is asked for new replies, when replies are on. */
export const TELEGRAM_POLL_MS = 5 * 60_000;

interface TgUpdate {
  update_id: number;
  message?: { chat?: { id?: number | string }; text?: string };
}

export interface RepliesDeps {
  config: ChannelConfigStore;
  env: SendEnv;
  store: Pick<Store, "listItems" | "setItemStatus" | "logEvent">;
  now: () => Date;
}

const HELP = "Reply /done 3 to close item 3 of today's brief.";

/**
 * Read "/done 3" replies to the brief with getUpdates (no webhook, nothing listening on this Mac).
 * Only messages from your own chat count; the number is the item's number in the last brief sent to
 * Telegram. Runs at most every 5 minutes, only when Telegram and replies are both on. Never throws.
 */
export async function pollTelegramReplies(deps: RepliesDeps, userId: string, opts: { force?: boolean } = {}): Promise<{ polled: boolean; closed: number }> {
  const file = deps.config.read();
  const tg = file.telegram;
  if (!tg.enabled || !tg.replies || !file.secretsSet.includes("telegramBot")) return { polled: false, closed: 0 };
  const now = deps.now();
  const last = file.telegramState.lastPollAt ? Date.parse(file.telegramState.lastPollAt) : 0;
  if (!opts.force && now.getTime() - last < TELEGRAM_POLL_MS - 10_000) return { polled: false, closed: 0 };

  let closed = 0;
  let offset = file.telegramState.offset;
  try {
    const token = await deps.env.secrets.get("telegramBot");
    if (!token) return { polled: false, closed: 0 };
    const updates = ((await telegramApi(deps.env.fetch, token, "getUpdates", {
      offset: file.telegramState.offset || undefined,
      timeout: 0,
      allowed_updates: ["message"],
    })) ?? []) as TgUpdate[];
    const numbers = file.telegramState.numbers;
    let items: Item[] | null = null;
    for (const u of updates) {
      offset = Math.max(offset, u.update_id + 1);
      const chat = u.message?.chat?.id;
      const text = u.message?.text ?? "";
      if (chat === undefined || String(chat) !== tg.chatId.trim()) continue; // someone else found the bot
      const reply = (t: string) => telegramApi(deps.env.fetch, token, "sendMessage", { chat_id: tg.chatId.trim(), text: t, parse_mode: "HTML" });
      if (/^\/(start|help)\b/i.test(text.trim())) {
        await reply(HELP);
        continue;
      }
      const n = parseDone(text);
      if (n === null) continue;
      const id = numbers?.itemIds[n - 1];
      items ??= await deps.store.listItems(userId);
      const item = id ? items.find((i) => i.id === id) : undefined;
      if (!item) {
        await reply(`There's no item ${n} in the last brief.`);
      } else if (item.status !== "open") {
        await reply(`Item ${n} is already closed: ${tgEscape(item.text)}`);
      } else {
        await deps.store.setItemStatus(item.id, "done", now.toISOString());
        item.status = "done";
        await deps.store.logEvent({ userId, type: "telegram_done", payload: { itemId: item.id } });
        await reply(`Done: <s>${tgEscape(item.text)}</s>`);
        closed++;
      }
    }
    deps.config.update((c) => {
      c.telegramState.offset = offset;
      c.telegramState.lastPollAt = now.toISOString();
    });
    return { polled: true, closed };
  } catch (e) {
    deps.config.update((c) => {
      c.telegramState.offset = offset; // replies already handled are not handled twice
      c.telegramState.lastPollAt = now.toISOString();
      setStatus(c, "telegram", { lastErrorAt: now.toISOString(), lastError: `replies: ${failureText(e)}` });
    });
    await logJobError(deps, userId, "telegram", e, { kind: "replies" });
    return { polled: true, closed };
  }
}
