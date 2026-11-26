// Ask with local search and branching threads, end to end through the route. The Anthropic SDK and
// every other provider are fakes; global fetch is replaced so any network call would fail the test.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ streams: [] as Array<{ model: string; messages: Array<{ role: string; content: string }> }>, chunks: ["Friday [1]."] as string[] }));
vi.mock("@anthropic-ai/sdk", async () => {
  const { fakeStream } = await import("@/lib/ai/fakes.test-helpers");
  class Anthropic {
    messages = {
      stream: (body: never) => { sdk.streams.push(body); return fakeStream(sdk.chunks).messages.stream(body); },
      create: () => { throw new Error("no network in tests"); },
    };
  }
  return { default: Anthropic };
});

const dir = mkdtempSync(join(tmpdir(), "db-ask-local-"));
process.env.DAILY_BRIEF_DIR = dir;
process.env.ANTHROPIC_API_KEY = "test-key-not-real";
process.env.EXTRACTION_MODEL = "claude-sonnet-5-5";

const realFetch = globalThis.fetch;
const netCalls: string[] = [];
globalThis.fetch = (async (u: string) => { netCalls.push(String(u)); throw new Error("network is off in tests"); }) as typeof fetch;
afterAll(() => { globalThis.fetch = realFetch; });

const { getFileStore } = await import("@/server/local/app");
const { POST } = await import("@/app/api/ask/route");
const { branchAction, openThreadAction, renameThreadAction, deleteThreadAction } = await import("@/app/ask-actions");
const cfg = await import("@/server/ai-config");
const { buildDocs, rankSources, retrieveLocal, ollamaEmbedder, vectorHits } = await import("@/server/ask-index");
const { setVault } = await import("@/server/integrations/vault");

let userId = "";
beforeAll(async () => {
  const store = getFileStore();
  const u = store.addUser({ email: "you@this-mac", name: "Maruthi", timeZone: "Asia/Kolkata" });
  userId = u.id;
  // A meeting from a local transcript file, so its transcript is searchable on this computer.
  const tfile = join(dir, "call.txt");
  writeFileSync(tfile, "Maruthi: The pricing page moves to the new grid.\nAsha: And the referral banner waits till January, agreed.\n");
  const m = (await store.upsertMeeting({ userId: u.id, providerMeetingId: "file:1", title: "Pricing review", startedAt: "2026-11-20T06:00:00Z", participants: ["Asha"], provider: "file", sourcePath: tfile } as never)).meeting;
  await store.commitExtraction({ meetingId: m.id, userId: u.id, at: "2026-11-20T07:00:00Z", closes: [], newItems: [
    { kind: "owe", text: "Send Asha the pricing grid", person: "Asha", quote: "The pricing page moves to the new grid", meetingId: m.id, dueAt: null },
  ] });
  mkdirSync(join(dir, "notes"), { recursive: true });
  writeFileSync(join(dir, "notes", "offsite.md"), "# Offsite\n\nVenue options: Goa or Coorg. Budget under 4 lakh.\n");
});

const ask = (body: unknown) => POST(new Request("http://localhost/api/ask", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }));
async function lines(r: Response) {
  return (await r.text()).trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("local search", () => {
  it("finds transcript chunks and notes on this computer, with no network call", async () => {
    const user = (await getFileStore().getUser(userId))!;
    const r = await retrieveLocal(user, "when does the referral banner go out?");
    expect(r.how).toBe("bm25");
    const t = r.sources.find((s) => s.type === "transcript");
    expect(t && "text" in t ? t.text : "").toContain("referral banner waits till January");
    const n = await retrieveLocal(user, "offsite venue budget");
    expect(n.sources[0]).toMatchObject({ type: "note", title: "Offsite", href: "/notes/offsite" });
    expect(netCalls).toEqual([]);
  });
  it("Search on this Mac only never sends text out for embeddings", async () => {
    cfg.saveAiPrefs((p) => { p.search = { localOnly: true, embeddings: "provider", embedModel: "e", embedProvider: "openai" }; });
    const user = (await getFileStore().getUser(userId))!;
    expect((await retrieveLocal(user, "pricing")).how).toBe("bm25");
    expect(netCalls).toEqual([]);
    cfg.saveAiPrefs((p) => { p.search = { ...cfg.SEARCH_DEFAULTS }; });
  });
  it("local Ollama embeddings are fused in when turned on, and cached", async () => {
    const calls: string[][] = [];
    const fake = (async (_u: string, init: { body: string }) => {
      const { input } = JSON.parse(init.body) as { input: string[] };
      calls.push(input);
      return { ok: true, json: async () => ({ embeddings: input.map((t) => (/january|referral/i.test(t) ? [1, 0] : [0, 1])) }) };
    }) as unknown as typeof fetch;
    const docs = buildDocs({ user: (await getFileStore().getUser(userId))!, items: [], meetings: [], pages: [{ slug: "a", title: "A", markdown: "referral banner in January", updatedAt: "x" }, { slug: "b", title: "B", markdown: "lunch", updatedAt: "x" }], dayNotes: [], transcripts: new Map() });
    const e = { embed: ollamaEmbedder("http://127.0.0.1:11434", "embed-model", fake), model: "ollama:embed-model" };
    const path = join(dir, "emb.json");
    const hits = await vectorHits(docs, "when is the referral thing", e, path);
    expect(hits![0].doc.id).toBe("note:a:0");
    const before = calls.length;
    await vectorHits(docs, "again", e, path);
    expect(calls.length).toBe(before + 1); // only the query this time
    const ranked = rankSources({ question: "referral" }, docs, [], [], new Date(), "UTC", hits!);
    expect(ranked[0]).toMatchObject({ n: 1, type: "note" });
  });
});

describe("Ask threads", () => {
  it("keeps a conversation, branches from a quote, and sends the branch's history", async () => {
    const out = await lines(await ask({ q: "what did we agree about the referral banner?" }));
    const tid = out[0].threadId as string;
    expect(out.at(-1)).toMatchObject({ type: "done" });
    const { view } = await openThreadAction(tid);
    expect(view!.turns).toHaveLength(1);
    expect(view!.turns[0].answer).toBe("Friday [1].");

    // Follow-up in the main thread: the first turn goes along as history.
    sdk.chunks = ["Asha said so [1]."];
    await lines(await ask({ q: "who said that?", threadId: tid }));
    const last = sdk.streams.at(-1)!;
    expect(last.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(last.messages[1].content).toBe("Friday.");

    // Branch from the first answer's cited quote: the main thread keeps both turns.
    const b = await branchAction(tid, view!.turns[0].id, "the referral banner waits till January");
    expect(b.ok).toBe(true);
    const id = (b as { id: string }).id;
    sdk.chunks = ["January [1]."];
    await lines(await ask({ q: "and the pricing page?", threadId: id }));
    const bm = sdk.streams.at(-1)!;
    expect(bm.messages).toHaveLength(3); // the fork turn, then the new question
    expect(bm.messages[2].content).toContain('About this quote: "the referral banner waits till January"');
    const main = await openThreadAction(tid);
    expect(main.view!.turns).toHaveLength(2);
    const br = await openThreadAction(id);
    expect(br.view!.inherited).toHaveLength(1);
    expect(br.view!.crumbs.map((c) => c.name)).toEqual(["Main thread", "“the referral banner waits till…”"]);
    expect(br.view!.tree.map((n) => n.depth)).toEqual([0, 1]);
    expect(br.conversations[0]).toMatchObject({ id: tid, branches: 1 });

    expect((await renameThreadAction(id, "Pricing side thread")).ok).toBe(true);
    expect((await openThreadAction(id)).view!.name).toBe("Pricing side thread");
    expect(await deleteThreadAction(id)).toEqual({ ok: true, next: tid });
    expect((await openThreadAction(tid)).view!.tree).toHaveLength(1);
    expect((await ask({ q: "x", threadId: id })).status).toBe(404);
  });

  it("answers with another provider picked for Ask, and its key problem is shown for it", async () => {
    const vault = { where: "file" as const, data: {} as Record<string, string>, async get(n: string) { return this.data[n] ?? null; }, async set(n: string, v: string) { this.data[n] = v; return true; }, async remove() {} };
    setVault(vault as never);
    await cfg.saveKey("groq", "gsk-test-not-real-000");
    cfg.saveAiPrefs((p) => { p.tasks.ask = { provider: "groq", model: "fast-model" }; });
    let fail = false;
    const bodies: Array<Record<string, unknown>> = [];
    cfg.setSdkFactory(() => ({ chat: { completions: { create: async (body: Record<string, unknown>) => {
      bodies.push(body);
      if (fail) throw Object.assign(new Error("Invalid API Key"), { status: 401 });
      return (async function* () { yield { choices: [{ delta: { content: "Grid [1]." } }] }; })();
    } } } }));
    const out = await lines(await ask({ q: "pricing grid?" }));
    expect(out[0]).toMatchObject({ provider: "groq", model: "groq:fast-model", providerLabel: "Groq" });
    expect(out.filter((l) => l.type === "text").map((l) => l.text).join("")).toBe("Grid [1].");
    expect(bodies[0].model).toBe("fast-model");
    fail = true;
    const bad = await lines(await ask({ q: "pricing grid?" }));
    expect(bad.at(-1)).toMatchObject({ type: "error", failure: "auth", error: "Your Groq API key was rejected. Check it in Settings." });
    expect(cfg.aiPrefs().problems.groq).toMatchObject({ kind: "auth" });
    expect((await getFileStore().getHealth()).anthropicProblem ?? null).toBeNull(); // not the Anthropic banner
    cfg.setSdkFactory(undefined);
    setVault(undefined);
    cfg.saveAiPrefs((p) => { p.tasks = {}; p.problems = {}; });
  });
});
