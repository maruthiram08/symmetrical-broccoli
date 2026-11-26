import { describe, expect, it } from "vitest";
import { fixtureBrief } from "@/lib/email/fixture";
import { briefDigest } from "@/lib/channels/digest";
import { slackMessage } from "@/lib/channels/slack";
import { parseDone, telegramText } from "@/lib/channels/telegram";
import { waParam } from "@/lib/channels/whatsapp";
import { redact } from "@/server/local/log";
import type { Keychain } from "@/server/local/keychain";
import { MemoryStore } from "@/server/store";
import { memoryChannelStore, type ChannelsFile } from "./config";
import { buildBundle, fanOut, type ChannelDeps } from "./deliver";
import type { Fetch } from "./http";
import { findMembers, matchMembers, nudgeText, nudgesReady, postDm, signConfirm, spendConfirm } from "./nudge";
import { pollTelegramReplies } from "./replies";
import { keychainSecrets, memorySecrets } from "./secrets";
import { sendEmail, type SendEnv, type SmtpFactory, type SmtpOptions } from "./senders";

interface Call { url: string; init: RequestInit; json: unknown }

/** A fetch that never leaves the process: `reply` decides each answer. */
function fakeFetch(reply: (c: Call) => { status?: number; body: unknown } = () => ({ body: { ok: true } })) {
  const calls: Call[] = [];
  const fn: Fetch = async (url, init) => {
    const raw = typeof init.body === "string" ? init.body : "";
    let json: unknown = raw;
    try { json = JSON.parse(raw); } catch { json = Object.fromEntries(new URLSearchParams(raw)); }
    const c = { url, init, json };
    calls.push(c);
    const r = reply(c);
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status ?? 200 });
  };
  return { fn, calls };
}

function fakeSmtp() {
  const sent: Array<{ opts: SmtpOptions; msg: Record<string, unknown> }> = [];
  let fail: Error | null = null;
  const factory: SmtpFactory = (opts) => ({
    sendMail: async (msg) => {
      if (fail) throw fail;
      sent.push({ opts, msg });
      return { messageId: "<m1@test>" };
    },
  });
  return { factory, sent, failWith: (e: Error) => { fail = e; } };
}

const TG_TOKEN = "123456789:AAEhBP0av18cH6vzr7Kq9Lq7q7q7q7q7q7q";
const SLACK_BOT = "xoxb-1111-2222-abcdefghijkl";

function setup(cfg: Partial<ChannelsFile> = {}, reply?: Parameters<typeof fakeFetch>[0]) {
  const http = fakeFetch(reply);
  const smtp = fakeSmtp();
  const secrets = memorySecrets({ smtpPassword: "abcd efgh ijkl mnop", slackBot: SLACK_BOT, telegramBot: TG_TOKEN, whatsappToken: "EAAGm0PX4ZCpsBAKZCZCtest1234567890", resendKey: "re_123456789abcdefghij" });
  const config = memoryChannelStore({ secretsSet: ["smtpPassword", "slackBot", "telegramBot", "whatsappToken"], ...cfg });
  const store = new MemoryStore();
  const env: SendEnv = { fetch: http.fn, secrets, smtp: smtp.factory, link: "http://localhost:4242" };
  const deps: ChannelDeps & { store: MemoryStore } = { config, env, store, now: () => new Date("2026-11-25T12:30:00Z") };
  return { http, smtp, secrets, config, store, env, deps };
}

const on = { brief: true, wrap: false, week: false };
const allOn = (): Partial<ChannelsFile> => ({
  email: { enabled: true, kinds: on, provider: "smtp", to: "me@example.com", from: "", smtpHost: "smtp.gmail.com", smtpPort: 587, smtpSecurity: "starttls", smtpUser: "me@gmail.com" },
  slack: { enabled: true, kinds: on, mode: "bot", userId: "U012ABCDEF" },
  telegram: { enabled: true, kinds: on, chatId: "424242", replies: false },
  whatsapp: { enabled: true, kinds: on, phoneNumberId: "1098765432", to: "+91 98123 45678", template: "daily_brief", language: "en", link: "" },
});

const bundle = () => buildBundle({ model: fixtureBrief, link: "http://localhost:4242" });

describe("fanOut", () => {
  it("sends nothing while every channel is off (the default)", async () => {
    const { deps, http, smtp } = setup();
    expect(await fanOut(deps, "u1", "2026-11-25", bundle())).toEqual([]);
    expect(http.calls).toHaveLength(0);
    expect(smtp.sent).toHaveLength(0);
  });

  it("sends the brief to every channel that is on, once per day", async () => {
    const { deps, http, smtp, config } = setup(allOn(), (c) => {
      if (c.url.includes("slack.com")) return { body: { ok: true, ts: "1.2" } };
      if (c.url.includes("telegram")) return { body: { ok: true, result: { message_id: 7 } } };
      return { body: { messages: [{ id: "wamid.1" }] } };
    });
    const r = await fanOut(deps, "u1", "2026-11-25", bundle());
    expect(r.map((x) => `${x.channel}:${x.status}`).sort()).toEqual(["email:sent", "slack:sent", "telegram:sent", "whatsapp:sent"]);
    expect(smtp.sent).toHaveLength(1);
    expect(http.calls.map((c) => new URL(c.url).host).sort()).toEqual(["api.telegram.org", "graph.facebook.com", "slack.com"]);
    expect(config.data.status.slack?.lastOkAt).toBe("2026-11-25T12:30:00.000Z");
    expect(config.data.telegramState.numbers).toEqual({ date: "2026-11-25", itemIds: ["item-banner", "item-ui-notes", "item-ca-config"] });

    const again = await fanOut(deps, "u1", "2026-11-25", bundle());
    expect(again.every((x) => x.status === "already_sent")).toBe(true);
    expect(smtp.sent).toHaveLength(1);
    expect(http.calls).toHaveLength(3);
  });

  it("keeps a failure in its own channel, records it and logs it without secrets", async () => {
    const { deps, smtp, config, store } = setup(allOn(), (c) => {
      if (c.url.includes("slack.com")) return { status: 200, body: { ok: false, error: `invalid_auth ${SLACK_BOT}` } };
      if (c.url.includes("telegram")) throw new Error(`connect ECONNREFUSED https://api.telegram.org/bot${TG_TOKEN}/sendMessage`);
      return { body: { messages: [{ id: "wamid.1" }] } };
    });
    const r = await fanOut(deps, "u1", "2026-11-25", bundle());
    const by = Object.fromEntries(r.map((x) => [x.channel, x]));
    expect(by.email.status).toBe("sent");
    expect(by.whatsapp.status).toBe("sent");
    expect(by.slack).toMatchObject({ status: "failed", error: "Slack HTTP 200 invalid_auth" });
    expect(by.telegram).toMatchObject({ status: "failed", error: "Telegram couldn't be reached" });
    expect(smtp.sent).toHaveLength(1);
    expect(config.data.status.slack?.lastError).toBe("brief: Slack HTTP 200 invalid_auth");
    const errors = store.events.filter((e) => e.type === "job_error");
    expect(errors.map((e) => (e.payload as { job: string }).job).sort()).toEqual(["slack", "telegram"]);
    const dump = JSON.stringify(store.events) + JSON.stringify(config.data);
    expect(dump).not.toContain(SLACK_BOT);
    expect(dump).not.toContain(TG_TOKEN);
    // A failed channel is tried again on the next delivery; the ones that worked are not.
    expect(config.data.sent).toEqual(expect.arrayContaining(["email:brief:2026-11-25", "whatsapp:brief:2026-11-25"]));
    expect(config.data.sent).not.toContain("slack:brief:2026-11-25");
  });

  it("routes the wrap and the recap by each channel's choice", async () => {
    const cfg = allOn();
    cfg.email!.kinds = { brief: false, wrap: false, week: true };
    cfg.slack!.kinds = { brief: true, wrap: true, week: false };
    cfg.telegram!.enabled = false;
    cfg.whatsapp!.enabled = false;
    const { deps, smtp, http } = setup(cfg, () => ({ body: { ok: true, ts: "1" } }));
    const b = bundle();
    b.wrap = { ...b.brief!, digest: { ...b.brief!.digest, kind: "wrap", subject: "Wrap" } };
    b.week = { ...b.brief!, email: { ...b.brief!.email, subject: "Your week" } };
    const r = await fanOut(deps, "u1", "2026-11-27", b);
    expect(r.map((x) => `${x.channel}:${x.kind}`).sort()).toEqual(["email:week", "slack:brief", "slack:wrap"]);
    expect(smtp.sent.map((s) => s.msg.subject)).toEqual(["Your week"]);
    expect(http.calls).toHaveLength(2);
  });
});

describe("email", () => {
  it("sends over SMTP with STARTTLS and the app password without spaces", async () => {
    const { env, smtp } = setup();
    const cfg = allOn().email!;
    await sendEmail(cfg, bundle().brief!, env);
    expect(smtp.sent[0].opts).toEqual({ host: "smtp.gmail.com", port: 587, secure: false, requireTLS: true, auth: { user: "me@gmail.com", pass: "abcdefghijklmnop" } });
    const m = smtp.sent[0].msg;
    expect(m).toMatchObject({ from: "me@gmail.com", to: "me@example.com", subject: fixtureBrief.subject });
    expect(String(m.html)).toContain("http://localhost:4242/item/item-banner");
    expect(String(m.text)).toContain("You owe (2 open)");
  });

  it("reports an SMTP failure by code only", async () => {
    const { env, smtp } = setup();
    smtp.failWith(Object.assign(new Error("Invalid login: 535 5.7.8 Username and Password not accepted abcd efgh"), { code: "EAUTH", responseCode: 535 }));
    await expect(sendEmail(allOn().email!, bundle().brief!, env)).rejects.toThrow("SMTP EAUTH 535 (check the user name and app password)");
  });

  it("sends through Resend with the API key", async () => {
    const { env, http } = setup({}, () => ({ body: { id: "re-id-1" } }));
    const cfg = { ...allOn().email!, provider: "resend" as const, from: "Daily brief <brief@mydomain.com>" };
    expect(await sendEmail(cfg, { ...bundle().brief!, prefix: "Test · " }, env)).toBe("re-id-1");
    expect(http.calls[0].url).toBe("https://api.resend.com/emails");
    expect((http.calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer re_123456789abcdefghij");
    expect(http.calls[0].json).toMatchObject({ from: "Daily brief <brief@mydomain.com>", to: ["me@example.com"], subject: `Test · ${fixtureBrief.subject}` });
  });

  it("says what's missing", async () => {
    const { env } = setup();
    await expect(sendEmail({ ...allOn().email!, to: "" }, bundle().brief!, env)).rejects.toThrow("Add the address to send to");
    env.secrets = memorySecrets();
    await expect(sendEmail(allOn().email!, bundle().brief!, env)).rejects.toThrow("The SMTP password isn't saved yet");
  });
});

describe("slack", () => {
  it("DMs you with Block Kit and collapses quotes into an attachment", async () => {
    const { deps, http } = setup({ slack: { enabled: true, kinds: on, mode: "bot", userId: "U012ABCDEF" } }, () => ({ body: { ok: true, ts: "1" } }));
    await fanOut(deps, "u1", "2026-11-25", bundle());
    const c = http.calls[0];
    expect(c.url).toBe("https://slack.com/api/chat.postMessage");
    expect((c.init.headers as Record<string, string>).authorization).toBe(`Bearer ${SLACK_BOT}`);
    const body = c.json as ReturnType<typeof slackMessage> & { channel: string };
    expect(body.channel).toBe("U012ABCDEF");
    expect(body.blocks[0]).toEqual({ type: "header", text: { type: "plain_text", text: "Wednesday, 25 November", emoji: false } });
    const all = JSON.stringify(body.blocks);
    expect(all).toContain("1. Send *Nitin* the final banner text  `4h late`");
    expect(all).not.toContain("half an hour"); // quotes are not in the main message
    expect(JSON.stringify(body.attachments)).toContain("I'll send it in half an hour");
  });

  it("posts to an incoming webhook", async () => {
    const { deps, http, secrets } = setup({ slack: { enabled: true, kinds: on, mode: "webhook", userId: "" } }, () => ({ body: "ok" }));
    await secrets.set("slackWebhook", "https://hooks.slack.com/services/T000/B000/XXXX");
    const r = await fanOut(deps, "u1", "2026-11-25", bundle());
    expect(r[0].status).toBe("sent");
    expect(http.calls[0].url).toBe("https://hooks.slack.com/services/T000/B000/XXXX");
    expect((http.calls[0].json as { blocks: unknown[] }).blocks.length).toBeGreaterThan(3);
  });

  it("escapes mrkdwn", () => {
    const m = structuredClone(fixtureBrief);
    m.youOwe[0].text = "Send <@channel> & <!here> the deck";
    expect(JSON.stringify(slackMessage(briefDigest(m)).blocks)).toContain("Send &lt;@channel&gt; &amp; &lt;!here&gt; the deck");
  });
});

describe("telegram", () => {
  it("sends HTML with numbered items and expandable quotes", () => {
    const t = telegramText(briefDigest(fixtureBrief), { replies: true });
    expect(t).toContain("<b>Wednesday, 25 November</b>");
    expect(t).toContain("1. Send <b>Nitin</b> the final banner text · <code>4h late</code>");
    expect(t).toContain("3. <b>Tarun</b> to confirm the corporate actions config");
    expect(t).toContain("<blockquote expandable>1. “I'll send it in half an hour” · Dividend banner, 1:51 PM");
    expect(t).toContain("Reply /done 3 to close item 3.");
  });

  it("stays under Telegram's limit", () => {
    const m = structuredClone(fixtureBrief);
    m.youOwe = Array.from({ length: 80 }, (_, i) => ({ ...fixtureBrief.youOwe[0], itemId: `x${i}`, text: `Send Nitin the long banner text number ${i} with more words` }));
    expect(telegramText(briefDigest(m)).length).toBeLessThanOrEqual(4096);
  });

  it("parses /done replies", () => {
    expect(parseDone("/done 3")).toBe(3);
    expect(parseDone("/done@MyBriefBot 12")).toBe(12);
    expect(parseDone("done #2")).toBe(2);
    expect(parseDone("/done")).toBeNull();
    expect(parseDone("I am done 3 times")).toBeNull();
  });

  function replySetup(updates: unknown[]) {
    const s = setup(
      { telegram: { enabled: true, kinds: on, chatId: "424242", replies: true }, telegramState: { offset: 10, lastPollAt: null, numbers: { date: "2026-11-25", itemIds: ["a", "b"] } } },
      (c) => (c.url.endsWith("/getUpdates") ? { body: { ok: true, result: updates } } : { body: { ok: true, result: {} } }),
    );
    const user = s.store.addUser({ email: "me@x" });
    for (const id of ["a", "b"]) {
      s.store.items.set(id, { id, userId: user.id, meetingId: "m", kind: "owe", text: `Item ${id}`, person: null, quote: "", dueAt: null, status: "open", closedByMeetingId: null, closeQuote: null, createdAt: "2026-11-25T00:00:00Z", closedAt: null } as never);
    }
    return { ...s, user };
  }

  it("closes the item a /done reply names, only from your chat", async () => {
    const { deps, http, store, user, config } = replySetup([
      { update_id: 10, message: { chat: { id: 999 }, text: "/done 1" } },
      { update_id: 11, message: { chat: { id: 424242 }, text: "/done 2" } },
      { update_id: 12, message: { chat: { id: 424242 }, text: "/done 2" } },
      { update_id: 13, message: { chat: { id: 424242 }, text: "/done 9" } },
    ]);
    const r = await pollTelegramReplies(deps, user.id);
    expect(r).toEqual({ polled: true, closed: 1 });
    expect(store.items.get("a")!.status).toBe("open");
    expect(store.items.get("b")!.status).toBe("done");
    expect(http.calls[0].json).toMatchObject({ offset: 10, timeout: 0 });
    const replies = http.calls.slice(1).map((c) => (c.json as { text: string }).text);
    expect(replies).toEqual(["Done: <s>Item b</s>", "Item 2 is already closed: Item b", "There's no item 9 in the last brief."]);
    expect(config.data.telegramState.offset).toBe(14);

    // Within 5 minutes: not asked again.
    expect(await pollTelegramReplies(deps, user.id)).toEqual({ polled: false, closed: 0 });
  });

  it("does nothing while replies are off (the default)", async () => {
    const { deps, http, user, config } = replySetup([]);
    config.update((c) => { c.telegram.replies = false; });
    expect(await pollTelegramReplies(deps, user.id)).toEqual({ polled: false, closed: 0 });
    expect(http.calls).toHaveLength(0);
  });
});

describe("whatsapp", () => {
  it("sends the approved template with title, summary and link", async () => {
    const { deps, http } = setup({ whatsapp: { ...allOn().whatsapp!, link: "https://my-mac.tailnet.ts.net" } }, () => ({ body: { messages: [{ id: "wamid.1" }] } }));
    await fanOut(deps, "u1", "2026-11-25", bundle());
    const c = http.calls[0];
    expect(c.url).toBe("https://graph.facebook.com/v21.0/1098765432/messages");
    expect(c.json).toEqual({
      messaging_product: "whatsapp",
      to: "919812345678",
      type: "template",
      template: {
        name: "daily_brief",
        language: { code: "en" },
        components: [{ type: "body", parameters: [
          { type: "text", text: "Wednesday, 25 November" },
          { type: "text", text: "You owe 2 (1 late), waiting on 1, 1 decision, 1 closed." },
          { type: "text", text: "https://my-mac.tailnet.ts.net" },
        ] }],
      },
    });
  });

  it("cleans template parameters", () => {
    expect(waParam("a\nb\t c     d")).toBe("a b c d");
    expect(waParam("")).toBe("-");
  });
});

describe("nudges over Slack", () => {
  it("needs bot mode and a saved token", () => {
    expect(nudgesReady({ slack: { enabled: false, kinds: on, mode: "bot", userId: "" }, secretsSet: ["slackBot"] })).toBe(true);
    expect(nudgesReady({ slack: { enabled: true, kinds: on, mode: "webhook", userId: "" }, secretsSet: ["slackWebhook"] })).toBe(false);
    expect(nudgesReady({ slack: { enabled: true, kinds: on, mode: "bot", userId: "" }, secretsSet: [] })).toBe(false);
  });

  it("finds the person among workspace members", async () => {
    const members = [
      { id: "U1", name: "tarun", profile: { real_name: "Tarun Kumar", display_name: "tarun", email: "tarun@x.com" } },
      { id: "U2", name: "tara", profile: { real_name: "Tara S" } },
      { id: "U3", name: "tarunbot", is_bot: true, profile: { real_name: "Tarun" } },
      { id: "U4", name: "old", deleted: true, profile: { real_name: "Tarun" } },
    ];
    expect(matchMembers(members, "Tarun")).toEqual([{ id: "U1", name: "Tarun Kumar", detail: "@tarun · tarun@x.com" }]);
    const { http, env } = setup({}, () => ({ body: { ok: true, members, response_metadata: { next_cursor: "" } } }));
    expect((await findMembers(env.fetch, SLACK_BOT, "Tarun"))[0].id).toBe("U1");
    expect(http.calls[0].url).toBe("https://slack.com/api/users.list");
    expect(http.calls[0].init.headers).toMatchObject({ "content-type": "application/x-www-form-urlencoded" });
  });

  it("a confirmation works once, for that recipient and that text only", () => {
    const now = Date.parse("2026-11-25T12:00:00Z");
    const c = signConfirm("item-1", "U1", "Hi Tarun, any update?", now);
    expect(spendConfirm("item-1", "U2", "Hi Tarun, any update?", c, now)).toBe(false);
    expect(spendConfirm("item-1", "U1", "Hi Tarun, send money", c, now)).toBe(false);
    expect(spendConfirm("item-1", "U1", "Hi Tarun, any update?", c, now + 11 * 60_000)).toBe(false);
    expect(spendConfirm("item-1", "U1", "Hi Tarun, any update?", c, now)).toBe(true);
    expect(spendConfirm("item-1", "U1", "Hi Tarun, any update?", c, now)).toBe(false);
    expect(spendConfirm("item-1", "U1", "x", { exp: now + 1000, sig: "forged" }, now)).toBe(false);
  });

  it("opens the DM and posts the text", async () => {
    const { http, env } = setup({}, (c) => (c.url.endsWith("conversations.open") ? { body: { ok: true, channel: { id: "D9" } } } : { body: { ok: true, ts: "5.5" } }));
    expect(await postDm(env.fetch, SLACK_BOT, "U1", "From Maru: any update?")).toBe("5.5");
    expect(http.calls.map((c) => c.url)).toEqual(["https://slack.com/api/conversations.open", "https://slack.com/api/chat.postMessage"]);
    expect(http.calls[0].json).toEqual({ users: "U1" });
    expect(http.calls[1].json).toMatchObject({ channel: "D9", text: "From Maru: any update?" });
  });

  it("says who it's from when the app sends it", () => {
    expect(nudgeText("Any update?", false, "Maru")).toBe("From Maru: Any update?");
    expect(nudgeText("Any update?", true, "Maru")).toBe("Any update?");
  });
});

describe("secrets", () => {
  it("stores any value in the Keychain, encoded so the helper accepts it", async () => {
    const box = new Map<string, string>();
    const kc: Keychain = {
      available: () => true,
      read: async (n) => box.get(n) ?? null,
      write: async (n, v) => { if (!/^[A-Za-z0-9+/=_.-]{8,512}$/.test(v)) return false; box.set(n, v); return true; },
      remove: async (n) => box.delete(n),
    };
    const s = keychainSecrets(kc);
    for (const v of ["https://hooks.slack.com/services/T0/B0/xyz", "abcd efgh ijkl mnop", "x"]) {
      expect(await s.set("slackWebhook", v)).toBe(true);
      expect(await s.get("slackWebhook")).toBe(v);
    }
    expect([...box.keys()]).toEqual(["CHANNEL_SLACK_WEBHOOK_URL"]);
    await s.remove("slackWebhook");
    expect(await s.get("slackWebhook")).toBeNull();
  });

  it("redacts channel credentials from logs", () => {
    const s = redact(`${SLACK_BOT} https://api.telegram.org/bot${TG_TOKEN}/x https://hooks.slack.com/services/T0/B0/abc re_123456789abcdefghij EAAGm0PX4ZCpsBAKZCZCtest1234567890`);
    for (const secret of [SLACK_BOT, TG_TOKEN, "T0/B0/abc", "re_123456789abcdefghij", "EAAGm0PX4ZCpsBAKZCZC"]) expect(s).not.toContain(secret);
  });
});

describe("files and health", () => {
  it("keeps settings in a 0600 file and secrets out of it", async () => {
    const { mkdtempSync, statSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { fileChannelStore } = await import("./config");
    const { fileSecrets } = await import("./secrets");
    const dir = mkdtempSync(join(tmpdir(), "ch-"));
    const store = fileChannelStore(join(dir, "channels.json"));
    expect(store.read().email.enabled).toBe(false);
    store.update((c) => { c.slack.enabled = true; c.slack.userId = "U1"; });
    expect(store.read().slack).toMatchObject({ enabled: true, userId: "U1", mode: "bot" });
    expect(statSync(join(dir, "channels.json")).mode & 0o777).toBe(0o600);
    const sec = fileSecrets(join(dir, "s.json"));
    await sec.set("slackBot", SLACK_BOT);
    expect(await sec.get("slackBot")).toBe(SLACK_BOT);
    expect(readFileSync(join(dir, "channels.json"), "utf8")).not.toContain(SLACK_BOT);
    expect(statSync(join(dir, "s.json")).mode & 0o777).toBe(0o600);
  });

  it("shows each channel that is on in Health", async () => {
    const { channelHealth } = await import("./health");
    const { config } = setup(allOn());
    config.update((c) => {
      c.status.email = { lastOkAt: "2026-11-25T12:30:00Z", lastErrorAt: null, lastError: null, lastTestAt: null };
      c.status.slack = { lastOkAt: "2026-11-24T12:30:00Z", lastErrorAt: "2026-11-25T12:30:05Z", lastError: "brief: Slack HTTP 200 invalid_auth", lastTestAt: null };
      c.whatsapp.enabled = false;
    });
    const h = channelHealth(config.read(), "Asia/Kolkata", new Date("2026-11-25T13:00:00Z"));
    expect(h.map((x) => `${x.label}: ${x.state} ${x.line}`)).toEqual([
      "Email: ok sent today, 6:00 PM",
      "Slack: failed failed today, 6:00 PM: brief: Slack HTTP 200 invalid_auth",
      "Telegram: never on, nothing sent yet",
    ]);
  });
});
