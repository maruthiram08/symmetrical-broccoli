import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type { AnthropicLike } from "@/lib/extract/extract";
import { AnthropicCallError } from "@/lib/extract/errors";
import { TOOL_NAME } from "@/lib/crosscheck/compare";
import { FileStore } from "@/server/local/file-store";
import { MemoryStore } from "@/server/store";
import { connect, FakeWispr, fakeDeps } from "@/server/testing";
import type { WisprClient } from "@/server/wispr/client";
import { ReconnectRequiredError } from "@/server/wispr/oauth";
import { processMeeting } from "@/server/jobs/process";
import { setAfterExtract, type AfterExtract } from "@/server/jobs/after-extract";
import { crossCheckMeeting, crosscheckAfterExtraction, crosscheckEnabled, droppedFor, saveCrosscheckEnabled, type CrossDeps } from "./core";
import { runCrossAll } from "./all";

const NOW = new Date("2026-11-26T12:00:00.000Z");
const SUMMARY = `## Summary
Banner and launch.

## Next steps
- Maruthi: send Nitin the final banner text
- Nitin to share the analytics dashboard with Maruthi
- Asha to book the venue
`;

let dir: string;
let prevDir: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "db-cross-"));
  prevDir = process.env.DAILY_BRIEF_DIR;
  process.env.DAILY_BRIEF_DIR = dir;
});
afterEach(() => {
  if (prevDir === undefined) delete process.env.DAILY_BRIEF_DIR; else process.env.DAILY_BRIEF_DIR = prevDir;
  setAfterExtract(undefined);
  rmSync(dir, { recursive: true, force: true });
});

function fakeModel(rows: unknown, bodies: Anthropic.MessageCreateParamsNonStreaming[] = []): AnthropicLike {
  return {
    messages: {
      create: (async (body: Anthropic.MessageCreateParamsNonStreaming) => {
        bodies.push(body);
        if (rows instanceof Error) throw rows;
        return {
          id: "m", type: "message", role: "assistant", model: body.model, stop_reason: "tool_use", stop_sequence: null,
          content: [{ type: "tool_use", id: "t", name: TOOL_NAME, input: rows }],
          usage: { input_tokens: 500, output_tokens: 80, cache_creation_input_tokens: null, cache_read_input_tokens: null },
        };
      }) as unknown as AnthropicLike["messages"]["create"],
    },
  };
}

const ROWS = {
  items: [
    { w: 1, match: "A1", involves_user: true, kind: "owe", person: "Nitin" },
    { w: 2, match: null, involves_user: true, kind: "waiting", person: "Nitin" },
    { w: 3, match: null, involves_user: false, kind: null, person: null },
  ],
};

async function setup(opts: { summary?: string | null; rows?: unknown } = {}) {
  const store = new FileStore(join(dir, ".daily-brief", "state.json"));
  const user = store.addUser({ email: "a@x.com", name: "Maruthi", aliases: ["Maru"] });
  const { meeting } = await store.upsertMeeting({ userId: user.id, providerMeetingId: "p1", title: "Banner sync", startedAt: "2026-11-25T09:00:00.000Z", participants: ["Nitin", "Asha"] });
  await store.commitExtraction({
    meetingId: meeting.id, userId: user.id, at: NOW.toISOString(), closes: [],
    newItems: [
      { kind: "owe", text: "Send Nitin the final banner copy", person: "Nitin", quote: "q", meetingId: meeting.id, dueAt: null },
      { kind: "owe", text: "Call the printer", person: null, quote: "q2", meetingId: meeting.id, dueAt: null },
    ],
  });
  const calls: string[] = [];
  const wisprClient: WisprClient = {
    listMeetingsSince: async () => [],
    getTranscript: async () => { throw new Error("the transcript must not be fetched"); },
    getSummary: async (id) => { calls.push(id); return opts.summary === undefined ? SUMMARY : opts.summary; },
    close: async () => {},
  };
  const bodies: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const deps: CrossDeps = {
    store, wispr: () => wisprClient, now: () => NOW,
    model: async () => ({ client: fakeModel(opts.rows ?? ROWS, bodies), model: "claude-plan:sonnet", provider: "claude-plan" }),
  };
  return { store, user, meeting, deps, calls, bodies };
}

describe("crossCheckMeeting", () => {
  it("fetches the summary, compares and stores the result per meeting", async () => {
    const { store, meeting, deps, calls, bodies, user } = await setup();
    const r = await crossCheckMeeting(deps, meeting.id);
    expect(calls).toEqual(["p1"]);
    expect(r).toMatchObject({ status: "ok", model: "claude-plan:sonnet" });
    if (!("status" in r)) throw new Error();
    expect(r.entries.map((e) => e.verdict)).toEqual(["matched", "missed", "not_user"]);
    expect(r.onlyInApp).toHaveLength(1);
    // Stored on disk: a fresh store sees it.
    const again = new FileStore(store.path);
    expect((await again.listCrossChecks(user.id))[0]).toMatchObject({ meetingId: meeting.id, status: "ok" });
    expect(bodies[0].model).toBe("claude-plan:sonnet");
    expect(JSON.stringify(bodies[0])).not.toContain("transcript must not");
    expect(await store.listEvents("crosscheck_run")).toHaveLength(1);
  });

  it("keeps Ignore and Add across a re-run", async () => {
    const { store, meeting, deps } = await setup();
    await crossCheckMeeting(deps, meeting.id);
    await store.updateCrossCheck(meeting.id, (r) => { r.entries[1].ignored = true; return true; });
    const r = await crossCheckMeeting(deps, meeting.id);
    expect("status" in r && r.entries[1].ignored).toBe(true);
  });

  it("records a missing summary or no next steps without calling the model", async () => {
    const a = await setup({ summary: null });
    expect(await crossCheckMeeting(a.deps, a.meeting.id)).toMatchObject({ status: "no_summary" });
    expect(a.bodies).toHaveLength(0);
    const b = await setup({ summary: "## Summary\nNothing to do." });
    expect(await crossCheckMeeting(b.deps, b.meeting.id)).toMatchObject({ status: "no_actions" });
  });

  it("stores model failures as an error record", async () => {
    const { meeting, deps } = await setup({ rows: new AnthropicCallError("credit", 400) });
    expect(await crossCheckMeeting(deps, meeting.id)).toMatchObject({ status: "error", failure: "credit" });
  });

  it("skips meetings that aren't read or aren't from Wispr Flow", async () => {
    const { store, user, deps } = await setup();
    const { meeting: m2 } = await store.upsertMeeting({ userId: user.id, providerMeetingId: "p2", title: "Later", startedAt: "2026-11-25T10:00:00.000Z", participants: [] });
    expect(await crossCheckMeeting(deps, m2.id)).toEqual({ skipped: "not_read" });
  });

  it("reads extraction's dropped texts from the newest extract_run", async () => {
    const { store, meeting } = await setup();
    await store.logEvent({ userId: null, type: "extract_run", payload: { meetingId: meeting.id, dropped: [{ reason: "old", text: "x" }] } });
    await store.logEvent({ userId: null, type: "extract_run", payload: { meetingId: meeting.id, dropped: [{ reason: "not the user's", text: "Asha books venue" }] } });
    expect(await droppedFor(store, meeting.id)).toEqual([{ reason: "not the user's", text: "Asha books venue" }]);
  });
});

describe("runCrossAll", () => {
  it("goes one meeting at a time with one connection and stops on reconnect", async () => {
    const { deps, meeting, user, store } = await setup();
    let opened = 0;
    let n = 0;
    const base = deps.wispr(user.id);
    deps.wispr = () => {
      opened++;
      return { ...base, getSummary: async () => { if (n++ === 1) throw new ReconnectRequiredError(); return SUMMARY; } };
    };
    const state = { done: 0, failed: 0, error: null as string | null };
    await runCrossAll(deps, user.id, [meeting.id, meeting.id, meeting.id], state);
    expect(opened).toBe(1);
    expect(state).toEqual({ done: 2, failed: 1, error: "Wispr Flow needs to be reconnected." });
    expect(await store.getCrossCheck(meeting.id)).toBeTruthy();
  });

  it("stops at once when the Extraction model has no key", async () => {
    const { deps, meeting, user } = await setup();
    deps.model = async () => ({ error: "Add ANTHROPIC_API_KEY to use this." });
    const state = { done: 0, failed: 0, error: null as string | null };
    await runCrossAll(deps, user.id, [meeting.id], state);
    expect(state).toEqual({ done: 0, failed: 0, error: "Add ANTHROPIC_API_KEY to use this." });
  });
});

describe("the switch and the hook after extraction", () => {
  it("is off by default and saved in prefs.json", () => {
    expect(crosscheckEnabled()).toBe(false);
    saveCrosscheckEnabled(true);
    expect(crosscheckEnabled()).toBe(true);
  });

  it("does nothing while off, and runs when on", async () => {
    const { store, meeting, deps } = await setup();
    const ev = { store, wispr: deps.wispr, meetingId: meeting.id, now: () => NOW };
    await crosscheckAfterExtraction(ev, deps.model);
    expect(await store.getCrossCheck(meeting.id)).toBeNull();
    saveCrosscheckEnabled(true);
    await crosscheckAfterExtraction(ev, deps.model);
    expect(await store.getCrossCheck(meeting.id)).toMatchObject({ status: "ok" });
  });

  it("never fails a read: process.ts calls the hook after commit and survives it throwing", async () => {
    const store = new MemoryStore();
    const wispr = new FakeWispr();
    const user = store.addUser({ email: "a@x.com", name: "Maruthi", aliases: [] });
    connect(store, user.id);
    const { meeting } = await store.upsertMeeting({ userId: user.id, providerMeetingId: "p1", title: "T", startedAt: "2026-11-25T09:00:00.000Z", participants: [] });
    wispr.transcripts.set("p1", "Maruthi: I'll send it.");
    const { deps } = fakeDeps({ store, wispr, now: NOW });
    const seen: AfterExtract[] = [];
    setAfterExtract(async (ev) => {
      seen.push(ev);
      expect(store.meetings.get(meeting.id)?.processedAt).toBeTruthy(); // after commit
      throw new Error("boom");
    });
    expect(await processMeeting(deps, meeting.id)).toMatchObject({ status: "processed" });
    expect(seen.map((e) => e.meetingId)).toEqual([meeting.id]);
  });
});
