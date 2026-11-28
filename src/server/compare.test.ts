// Settings › AI › Compare: estimates first, runs only a confirmed estimate once, lines up the finds.
// The extractor and the transcript are fakes: no provider, recorder or Wispr call.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { diffCloses, diffItems, estimatePairs, sameFind, totalEstimate, type NewItem } from "@/lib/ai/compare";
import type { ExtractionInput } from "@/lib/types";

process.env.DAILY_BRIEF_DIR = mkdtempSync(join(tmpdir(), "db-compare-"));
process.env.EXTRACTION_MODEL = "claude-sonnet-5-5";

const { getStore, getFileStore } = await import("@/server/local/app");
const { estimateCompare, parsePairs, runCompare, CONFIRM_TTL_MS } = await import("./compare");
const cfg = await import("./ai-config");

const item = (text: string, quote: string, kind: NewItem["kind"] = "owe"): NewItem => ({ kind, text, person: "Asha", quote, dueAt: null } as NewItem);

describe("diff and estimates (pure)", () => {
  it("lines up the same find across pairs and marks what differs", () => {
    const a = [item("Send Asha the pricing grid", "send you the grid"), item("Book the venue", "book Goa", "decision")];
    const b = [item("Send the pricing grid to Asha", "I'll send you the grid today")];
    expect(sameFind(a[0], b[0])).toBe(true);
    const rows = diffItems([a, b, null]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ kind: "owe", agreed: true });
    expect(rows[0].cells[2]).toBeNull();
    expect(rows[1]).toMatchObject({ kind: "decision", agreed: false });
    expect(diffCloses([[{ itemId: "i1", quote: "done" } as never], []])).toEqual([{ itemId: "i1", by: [true, false] }]);
  });
  it("estimates free, plan, priced and unknown pairs", () => {
    const input = { transcript: "x".repeat(4000), user: { name: "M", aliases: [], timeZone: "UTC" }, meeting: { title: "t", startedAt: "2026-11-20T00:00:00Z", participants: [] }, openItems: [] } as ExtractionInput;
    const es = estimatePairs(input, ["ollama:q", "claude-plan:sonnet", "groq:g", "openai:m"], (q) => (q === "groq:g" ? { input: 1, output: 1 } : null));
    expect(es.map((e) => e.note)).toEqual(["free", "plan", null, "unknown"]);
    expect(es[2].costInr).toBeGreaterThan(0);
    expect(totalEstimate(es)).toMatchObject({ unknown: 1 });
  });
  it("needs 2 or 3 different pairs with a model each", () => {
    expect(parsePairs([{ provider: "openai", model: "a" }])).toMatch(/Pick 2 or 3/);
    expect(parsePairs([{ provider: "openai", model: "a" }, { provider: "openai", model: "a" }])).toMatch(/different/);
    expect(parsePairs([{ provider: "openai", model: "a" }, { provider: "groq", model: "" }])).toMatch(/model name/);
    expect(parsePairs([{ provider: "claude-plan", model: "sonnet" }, { provider: "groq", model: "g" }], true)).toMatch(/provider/);
    expect(parsePairs([{ provider: "ollama", model: "q" }, { provider: "groq", model: "g" }, { provider: "", model: "" }])).toHaveLength(2);
  });
});

describe("estimate, confirm, run", () => {
  let userId = "", meetingId = "";
  beforeAll(async () => {
    const store = getStore();
    const u = await getFileStore().addUser({ email: "you@this-mac", name: "Maruthi", timeZone: "Asia/Kolkata" });
    userId = u.id;
    meetingId = (await store.upsertMeeting({ userId, providerMeetingId: "c1", title: "Pricing review", startedAt: "2026-11-20T06:00:00Z", participants: ["Asha"] })).meeting.id;
    cfg.saveAiPrefs((p) => { p.prices["groq:g"] = { input: 1, output: 2 }; });
  });
  const transcript = async () => "Maruthi: I'll send you the grid today.";

  it("runs nothing without a confirmed estimate, and a confirmation once only", async () => {
    const user = (await getStore().getUser(userId))!;
    const pairs = parsePairs([{ provider: "groq", model: "g" }, { provider: "ollama", model: "q" }]) as never;
    const est = await estimateCompare(user, meetingId, pairs, { transcript });
    expect(est.meetingTitle).toBe("Pricing review");
    expect(est.estimates.map((e) => e.costLabel)).toEqual([expect.stringMatching(/^≈ ₹/), "free (on this computer)"]);
    const extractor = vi.fn(async (pair: { provider: string }) => {
      if (pair.provider === "groq") return { newItems: [item("Send Asha the grid", "send you the grid")], closes: [], usage: { inputTokens: 1000, outputTokens: 100 } };
      return { newItems: [], closes: [], usage: { inputTokens: 1000, outputTokens: 100 } };
    });
    expect(await runCompare(user, "made-up", extractor as never)).toMatch(/expired/);
    expect(extractor).not.toHaveBeenCalled();
    const r = await runCompare(user, est.confirmId, extractor as never);
    expect(typeof r).toBe("object");
    if (typeof r === "string") return;
    expect(extractor).toHaveBeenCalledTimes(2);
    expect(r.pairs.map((p) => p.ok)).toEqual([true, true]);
    expect(r.pairs[1].costLabel).toBe("free");
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].agreed).toBe(false);
    expect(await runCompare(user, est.confirmId, extractor as never)).toMatch(/expired/); // once only
    expect(extractor).toHaveBeenCalledTimes(2);
  });
  it("an estimate expires after 10 minutes; a failing pair shows its own error", async () => {
    const user = (await getStore().getUser(userId))!;
    const pairs = parsePairs([{ provider: "groq", model: "g" }, { provider: "openai", model: "m" }]) as never;
    const t = Date.now();
    const est = await estimateCompare(user, meetingId, pairs, { transcript }, t);
    const extractor = vi.fn();
    expect(await runCompare(user, est.confirmId, extractor as never, t + CONFIRM_TTL_MS + 1)).toMatch(/expired/);
    expect(extractor).not.toHaveBeenCalled();
    const est2 = await estimateCompare(user, meetingId, pairs, { transcript });
    const { AnthropicCallError } = await import("@/lib/extract/errors");
    const r = await runCompare(user, est2.confirmId, (async (pair: { provider: string }) => {
      if (pair.provider === "openai") throw new AnthropicCallError("auth", 401);
      return { newItems: [], closes: [], usage: { inputTokens: 1, outputTokens: 1 } };
    }) as never);
    if (typeof r === "string") throw new Error(r);
    expect(r.pairs[1]).toMatchObject({ ok: false, error: "Your OpenAI API key was rejected. Check it in Settings." });
    expect(cfg.aiPrefs().problems.openai).toMatchObject({ kind: "auth" });
  });
});
