// The Ask route end to end (with the Anthropic SDK mocked), and Keep both / Mark old as replaced.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ streams: [] as unknown[], chunks: [] as string[], fail: undefined as Error | undefined }));
vi.mock("@anthropic-ai/sdk", async () => {
  const { fakeStream } = await import("@/lib/ai/fakes.test-helpers");
  class Anthropic {
    messages = {
      stream: (body: unknown) => { sdk.streams.push(body); return fakeStream(sdk.chunks, {}, sdk.fail).messages.stream(body as never); },
      create: () => { throw new Error("no network in tests"); },
    };
  }
  return { default: Anthropic };
});

process.env.DAILY_BRIEF_DIR = mkdtempSync(join(tmpdir(), "db-ask-"));
process.env.ANTHROPIC_API_KEY = "test-key-not-real";
process.env.EXTRACTION_MODEL = "claude-sonnet-5-5";

const { getFileStore: getStore } = await import("@/server/local/app");
const { getAiStore } = await import("@/server/local/ai-store");
const { POST } = await import("@/app/api/ask/route");
const { openContradictions, resolveContradiction } = await import("@/server/ai");

let userId = "";
beforeAll(async () => {
  const store = getStore();
  const u = store.addUser({ email: "you@this-mac", name: "Maruthi", timeZone: "Asia/Kolkata" });
  userId = u.id;
  const m = (await store.upsertMeeting({ userId: u.id, providerMeetingId: "1", title: "Banner review", startedAt: "2026-11-20T06:00:00Z", participants: ["Tarun"] })).meeting;
  const m2 = (await store.upsertMeeting({ userId: u.id, providerMeetingId: "2", title: "Standup", startedAt: "2026-11-24T06:00:00Z", participants: [] })).meeting;
  await store.commitExtraction({ meetingId: m.id, userId: u.id, at: "2026-11-20T07:00:00Z", closes: [], newItems: [
    { kind: "decision", text: "Ship the dividend banner on Friday", person: null, quote: "we ship the banner Friday", meetingId: m.id, dueAt: null },
    { kind: "owe", text: "Send Tarun the banner copy", person: "Tarun", quote: "I'll send you the banner copy", meetingId: m.id, dueAt: null },
  ] });
  await store.commitExtraction({ meetingId: m2.id, userId: u.id, at: "2026-11-24T07:00:00Z", closes: [], newItems: [
    { kind: "decision", text: "Ship the dividend banner on Monday", person: null, quote: "banner goes Monday", meetingId: m2.id, dueAt: null },
  ] });
});

const ask = (body: unknown) => POST(new Request("http://localhost/api/ask", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }));
async function lines(r: Response) {
  return (await r.text()).trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("POST /api/ask", () => {
  it("streams sources, text and the cost, and logs the tokens", async () => {
    sdk.chunks = ["You moved it to Monday [1], ", "after first saying Friday [2]."];
    const r = await ask({ q: "when do we ship the banner?" });
    expect(r.headers.get("Content-Type")).toContain("ndjson");
    const out = await lines(r);
    expect(out[0]).toMatchObject({ type: "sources", model: "claude-sonnet-5-5" });
    const sources = out[0].sources as Array<{ n: number; text: string; href: string; quote: string }>;
    expect(sources.length).toBe(3);
    expect(sources.find((s) => s.text.startsWith("Send Tarun"))!.href).toBe("/people/tarun");
    expect(out.filter((l) => l.type === "text").map((l) => l.text).join("")).toBe(sdk.chunks.join(""));
    expect(out.at(-1)).toMatchObject({ type: "done", noAnswer: false });
    expect((sdk.streams[0] as { model: string }).model).toBe("claude-sonnet-5-5");
    const ev = (await getStore().listEvents("ask"))[0] as { tokensIn: number; payload: Record<string, unknown> };
    expect(ev.tokensIn).toBe(1000);
    expect(JSON.stringify(ev.payload)).not.toContain("banner"); // the question isn't logged
  });
  it("answers without Claude when nothing relates, and gives an estimate on request", async () => {
    const before = sdk.streams.length;
    const out = await lines(await ask({ q: "what is the capital of France" }));
    expect(out.map((l) => l.type)).toEqual(["sources", "text", "done"]);
    expect(out[1].text).toBe("I don't see that in your meetings.");
    expect(sdk.streams.length).toBe(before);
    const est = await (await ask({ q: "banner", estimateOnly: true })).json();
    expect(est.estimate.costInr).toBeGreaterThan(0);
    expect((await ask({ q: "" })).status).toBe(400);
  });
});

describe("Ask and account problems", () => {
  it("a rejected key shows the Settings banner; a good answer clears it", async () => {
    sdk.fail = Object.assign(new Error("nope"), { status: 401 });
    const out = await lines(await ask({ q: "banner" }));
    expect(out.at(-1)).toMatchObject({ type: "error", failure: "auth" });
    expect((await getStore().getHealth()).anthropicProblem).toMatchObject({ kind: "auth" });
    sdk.fail = undefined;
    sdk.chunks = ["Monday [1]."];
    await lines(await ask({ q: "banner" }));
    expect((await getStore().getHealth()).anthropicProblem).toBeNull();
  });
});

describe("contradiction actions", () => {
  it("lists open flags and marks the old decision replaced", async () => {
    const items = await getStore().listItems(userId);
    const oldD = items.find((i) => i.text.endsWith("Friday"))!, newD = items.find((i) => i.text.endsWith("Monday"))!;
    getAiStore().addContradiction({ id: "c1", newId: newD.id, oldId: oldD.id, note: "moved to Monday", createdAt: "x", status: "open" });
    getAiStore().addContradiction({ id: "c2", newId: newD.id, oldId: items.find((i) => i.kind === "owe")!.id, note: "", createdAt: "x", status: "open" });
    const user = (await getStore().getUser(userId))!;
    expect((await openContradictions(user)).map((c) => c.id)).toEqual(["c1", "c2"]);
    await resolveContradiction(user, "c2", "keep");
    await resolveContradiction(user, "c1", "replace");
    expect((await getStore().listItems(userId)).find((i) => i.id === oldD.id)!.status).toBe("done");
    expect(await openContradictions(user)).toEqual([]);
  });
});
