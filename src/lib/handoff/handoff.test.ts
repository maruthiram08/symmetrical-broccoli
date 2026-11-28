import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type { AnthropicLike } from "../extract/extract";
import type { Item } from "../types";
import { DraftCache } from "./cache";
import { buildContext, samePerson } from "./context";
import { draftHandoff, templateDrafts, textProblems, validateDrafts } from "./draft";
import { isHinglish } from "./lang";
import { CLAUDE_URL_MAX, claudeUrl, fitEncoded, mailtoUrl, MAILTO_MAX } from "./links";
import { contextPack } from "./pack";
import { DRAFT_TOOL_NAME, buildDraftMessage } from "./prompt";
import { latestHandoffs, startedLabel } from "./started";
import { templateDraft } from "./template";
import type { HandoffContext } from "./types";
import { wordCount } from "./format";

const item = (over: Partial<Item> = {}): Item => ({
  id: "i1", userId: "u", kind: "waiting", text: "Push the build to staging", person: "Nitin",
  quote: "I'll push the build to staging by 5.", meetingId: "m1", dueAt: "2026-11-25T11:30:00.000Z",
  status: "open", closedByMeetingId: null, closeQuote: null, createdAt: "2026-11-25T09:00:00.000Z", closedAt: null, ...over,
});

const meetings = new Map([
  ["m1", { title: "Dividend banner", startedAt: "2026-11-25T08:21:00.000Z" }],
  ["m2", { title: "Standup", startedAt: "2026-11-24T04:00:00.000Z" }],
]);

const ctxFor = (it: Item, all: Item[] = [it]): HandoffContext =>
  buildContext({ item: it, user: { name: "Maruthi", timeZone: "Asia/Kolkata" }, meetings, allItems: all, now: new Date("2026-11-25T10:00:00Z") })!;

function fakeClient(toolInput: unknown, over: Partial<Anthropic.Message> = {}) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const create = vi.fn(async (_body: Anthropic.MessageCreateParamsNonStreaming) => ({
    id: "msg", type: "message", role: "assistant", model: "claude-sonnet-5-5", stop_reason: "tool_use", stop_sequence: null,
    content: [{ type: "tool_use", id: "t1", name: DRAFT_TOOL_NAME, input: toolInput }],
    usage: { input_tokens: 600, output_tokens: 120, cache_creation_input_tokens: null, cache_read_input_tokens: null },
    ...over,
  }) as unknown as Anthropic.Message);
  const client: AnthropicLike = { messages: { create } };
  return { client, create };
}

const good = {
  slack: "Hey Nitin, any update on the staging build? You'd said by 5. Let me know if it's slipping.",
  email_subject: "Staging build",
  email_body: "Hi Nitin,\n\nChecking on the staging build you'd planned for 5. Any update?\n\nThanks,\nMaruthi",
};

describe("buildContext", () => {
  it("collects related items with the same person, open first, skips wrong and decisions", () => {
    const all = [
      item(),
      item({ id: "i2", kind: "owe", text: "Send Nitin the banner text", meetingId: "m2", createdAt: "2026-11-24T05:00:00Z" }),
      item({ id: "i3", text: "Share logs", person: "nitin kumar", status: "done", createdAt: "2026-11-25T09:30:00Z" }),
      item({ id: "i4", text: "Wrong one", status: "wrong" }),
      item({ id: "i5", text: "Ask Priya", person: "Priya" }),
      item({ id: "i6", kind: "decision", text: "Ship it", person: null }),
    ];
    const ctx = ctxFor(all[0], all);
    expect(ctx.related.map((r) => r.text)).toEqual(["Send Nitin the banner text", "Share logs"]);
    expect(ctx.related[0].meetingTitle).toBe("Standup");
    expect(ctx.meeting?.title).toBe("Dividend banner");
  });
  it("returns null for decisions", () => {
    expect(buildContext({ item: item({ kind: "decision" }), user: { name: "M", timeZone: "UTC" }, meetings, allItems: [], now: new Date() })).toBeNull();
  });
  it("matches people by name or first name only", () => {
    expect(samePerson("Nitin", "nitin")).toBe(true);
    expect(samePerson("Nitin Kumar", "Nitin")).toBe(true);
    expect(samePerson("Nitin K", "Nitin S")).toBe(false);
    expect(samePerson(null, "Nitin")).toBe(false);
  });
});

describe("prompt", () => {
  it("sends the item, quote, meeting and related items, and nothing like a transcript", () => {
    const all = [item(), item({ id: "i2", kind: "owe", text: "Send Nitin the banner text" })];
    const msg = buildDraftMessage(ctxFor(all[0], all));
    expect(msg).toContain("Kind: waiting");
    expect(msg).toContain('"I\'ll push the build to staging by 5."');
    expect(msg).toContain("Dividend banner, 25 Nov, 1:51 PM");
    expect(msg).toContain("open | owe | Send Nitin the banner text");
    expect(msg).toContain("Quote is Hinglish: no");
    expect(msg).not.toMatch(/transcript/i);
  });
  it("flags Hinglish quotes", () => {
    expect(isHinglish("Haan, main half an hour mein bhej deta hoon")).toBe(true);
    expect(isHinglish("I'll push the build to staging by 5.")).toBe(false);
    expect(isHinglish("Do it and we can go")).toBe(false);
    expect(isHinglish("कल भेज दूंगा")).toBe(true);
  });
});

describe("templates", () => {
  it("nudges for waiting and gives a status update for owe, short enough for Slack", () => {
    const w = templateDraft(ctxFor(item()));
    expect(w.slack).toMatch(/^Hi Nitin, quick nudge/);
    expect(w.emailSubject).toBe("Following up: Push the build to staging");
    const o = templateDraft(ctxFor(item({ kind: "owe", text: "Send Nitin the final banner text" })));
    expect(o.slack).toContain("update on send Nitin the final banner text");
    expect(o.emailBody.endsWith("Maruthi")).toBe(true);
    for (const d of [w, o]) {
      expect(wordCount(d.slack)).toBeLessThan(80);
      expect(d.slack).not.toContain("!");
    }
  });
  it("works without a person or meeting", () => {
    const ctx = buildContext({ item: item({ person: null, meetingId: "gone" }), user: { name: "Maruthi", timeZone: "UTC" }, meetings, allItems: [], now: new Date() })!;
    expect(templateDraft(ctx).slack).toMatch(/^Hi, quick nudge on this: "/);
  });
});

describe("validateDrafts", () => {
  const ctx = ctxFor(item());
  it("accepts a plain short draft", () => {
    expect(validateDrafts(good, ctx)).toEqual({ slack: [], email: [] });
  });
  it("rejects filler, emoji, exclamation marks, placeholders and long Slack messages", () => {
    const hinglish = { maxWords: 80, quoteIsHinglish: false };
    expect(textProblems("Hi Nitin, I hope this finds you well.", hinglish)).not.toEqual([]);
    expect(textProblems("Thanks so much!", hinglish)).not.toEqual([]);
    expect(textProblems("Done \u{1F44D}", hinglish)).not.toEqual([]);
    expect(textProblems("Here is the link: [link]", hinglish)).not.toEqual([]);
    expect(textProblems(Array(81).fill("word").join(" "), hinglish)).toEqual(["over 80 words"]);
    expect(textProblems("Haan bhai, kal bhej dunga", hinglish)).toContain("Hinglish without a Hinglish quote");
    expect(textProblems("Haan bhai, kal bhej dunga", { maxWords: 80, quoteIsHinglish: true })).toEqual([]);
  });
});

describe("draftHandoff", () => {
  it("makes one call with no transcript and returns validated drafts", async () => {
    const { client, create } = fakeClient(good);
    const r = await draftHandoff(ctxFor(item()), { client, model: "claude-sonnet-5-5" });
    expect(create).toHaveBeenCalledTimes(1);
    const body = create.mock.calls[0][0];
    expect(body.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
    expect(body.thinking).toBeUndefined();
    expect(JSON.stringify(body.messages)).not.toMatch(/<transcript>/);
    expect(r.drafts.slack).toBe(good.slack);
    expect(r.drafts.slackSource).toBe("ai");
    expect(r.drafts.emailSource).toBe("ai");
    expect(r.drafts.claudePrompt).toContain("Waiting on: Nitin");
    expect(r.fallback).toBeNull();
    expect(r.usage).toEqual({ inputTokens: 600, outputTokens: 120 });
  });
  it("falls back to the template per target when a draft fails validation", async () => {
    const { client } = fakeClient({ ...good, slack: "Hi Nitin! I hope this finds you well." });
    const r = await draftHandoff(ctxFor(item()), { client, model: "m" });
    expect(r.drafts.slackSource).toBe("template");
    expect(r.drafts.slack).toMatch(/^Hi Nitin, quick nudge/);
    expect(r.drafts.emailSource).toBe("ai");
    expect(r.fallback).toMatch(/^slack:/);
  });
  it("falls back to templates on API errors, missing tool calls, bad shapes and refusals", async () => {
    const ctx = ctxFor(item());
    const boom: AnthropicLike = { messages: { create: async () => { throw new Error("network"); } } };
    expect((await draftHandoff(ctx, { client: boom, model: "m" })).drafts).toEqual(templateDrafts(ctx));
    const noTool = fakeClient(good, { content: [{ type: "text", text: "Here you go", citations: null }] as Anthropic.Message["content"], stop_reason: "end_turn" });
    expect((await draftHandoff(ctx, { client: noTool.client, model: "m" })).fallback).toBe("no tool call");
    expect((await draftHandoff(ctx, { client: fakeClient({ slack: 3 }).client, model: "m" })).fallback).toBe("schema");
    expect((await draftHandoff(ctx, { client: fakeClient(good, { stop_reason: "refusal" }).client, model: "m" })).drafts.slackSource).toBe("template");
  });
});

describe("contextPack", () => {
  it("has the item, person, quote, meeting, related open items and an instruction", () => {
    const all = [
      item({ kind: "owe", text: "Send Nitin the final banner text" }),
      item({ id: "i2", text: "Push the build to staging" }),
      item({ id: "i3", text: "Old thing", status: "done" }),
    ];
    const p = contextPack(ctxFor(all[0], all));
    expect(p).toContain("I'm Maruthi.");
    expect(p).toContain("What I owe: Send Nitin the final banner text");
    expect(p).toContain("Owed to: Nitin");
    expect(p).toContain('Exact words from the meeting: "I\'ll push the build to staging by 5."');
    expect(p).toContain("Meeting: Dividend banner, 25 Nov, 1:51 PM");
    expect(p).toContain("Deadline: due 25 Nov, 5:00 PM");
    expect(p).toContain("- Waiting on them: Push the build to staging (Dividend banner)");
    expect(p).not.toContain("Old thing");
    expect(p).toContain("Don't send anything on my behalf.");
  });
});

describe("links", () => {
  it("builds a mailto with an empty To and keeps it short", () => {
    const u = mailtoUrl("Staging build", "Hi Nitin,\n\nAny update?");
    expect(u).toBe("mailto:?subject=Staging%20build&body=Hi%20Nitin%2C%0A%0AAny%20update%3F");
    expect(mailtoUrl("s", "x ".repeat(5000)).length).toBeLessThanOrEqual(MAILTO_MAX + 20);
  });
  it("truncates the Claude prompt without breaking characters", () => {
    const long = "नमस्ते 😀 ".repeat(2000);
    const u = claudeUrl(long);
    expect(u.startsWith("https://claude.ai/new?q=")).toBe(true);
    expect(u.length).toBeLessThanOrEqual(CLAUDE_URL_MAX);
    expect(() => decodeURIComponent(u.slice(24))).not.toThrow();
    expect(decodeURIComponent(u.slice(24))).toContain("[Cut short.");
    expect(fitEncoded("short", 100)).toBe("short");
  });
});

describe("started", () => {
  it("keeps the latest hand-off per item for this user and labels it", () => {
    const ev = [
      { type: "handoff", userId: "u", payload: { itemId: "i1", target: "email", how: "copy" }, at: "2026-11-25T16:00:00.000Z" },
      { type: "handoff", userId: "u", payload: { itemId: "i1", target: "slack", how: "open" }, at: "2026-11-25T17:12:00.000Z" },
      { type: "handoff", userId: "other", payload: { itemId: "i2", target: "slack" }, at: "2026-11-25T17:12:00.000Z" },
      { type: "handoff", userId: "u", payload: { itemId: "i3", target: "fax" }, at: "2026-11-25T17:12:00.000Z" },
      { type: "brief_sent", userId: "u", payload: { itemId: "i4" }, at: "2026-11-25T17:12:00.000Z" },
    ];
    const m = latestHandoffs(ev, "u");
    expect([...m.keys()]).toEqual(["i1"]);
    expect(m.get("i1")).toMatchObject({ target: "slack", how: "open" });
    const now = new Date("2026-11-25T17:30:00Z");
    expect(startedLabel(m.get("i1")!, "Asia/Kolkata", now)).toBe("Started in Slack, 10:42 PM");
    expect(startedLabel({ target: "claude", at: "2026-11-23T05:00:00Z" }, "Asia/Kolkata", now)).toBe("Started in Claude, 23 Nov, 10:30 AM");
  });
});

describe("DraftCache", () => {
  it("drafts once per item, sharing concurrent requests", async () => {
    const c = new DraftCache();
    const ctx = ctxFor(item());
    const make = vi.fn(async () => templateDrafts(ctx));
    const [a, b] = await Promise.all([c.getOrMake("i1", make), c.getOrMake("i1", make)]);
    expect(make).toHaveBeenCalledTimes(1);
    expect(a.drafts).toEqual(b.drafts);
    expect((await c.getOrMake("i1", make)).cached).toBe(true);
    expect(make).toHaveBeenCalledTimes(1);
    await c.getOrMake("i2", make);
    expect(make).toHaveBeenCalledTimes(2);
  });
  it("does not cache a failed draft", async () => {
    const c = new DraftCache();
    await expect(c.getOrMake("i1", async () => { throw new Error("x"); })).rejects.toThrow("x");
    expect(c.get("i1")).toBeNull();
  });
});
