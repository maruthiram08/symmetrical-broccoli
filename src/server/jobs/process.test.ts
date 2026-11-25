import { describe, expect, it } from "vitest";
import { MemoryStore } from "@/server/store";
import { connect, FakeWispr, fakeDeps } from "@/server/testing";
import { processMeeting, processPending } from "./process";

const NOW = new Date("2026-11-25T12:00:00.000Z");
const TRANSCRIPT = "Maruthi: I'll send Nitin the final banner text by Friday. SECRET-TRANSCRIPT-MARKER";

async function setup() {
  const store = new MemoryStore();
  const wispr = new FakeWispr();
  const user = store.addUser({ email: "a@x.com", name: "Maruthi", aliases: ["Maru"] });
  connect(store, user.id);
  const { meeting } = await store.upsertMeeting({ userId: user.id, providerMeetingId: "p1", title: "Banner sync", startedAt: "2026-11-25T09:00:00.000Z", participants: ["Nitin"] });
  wispr.transcripts.set("p1", TRANSCRIPT);
  const f = fakeDeps({ store, wispr, now: NOW });
  return { store, wispr, user, meeting, ...f };
}

describe("processMeeting", () => {
  it("extracts, commits and logs an extract_run with tokens and cost", async () => {
    const { deps, store, meeting, extractCalls, user } = await setup();
    expect(await processMeeting(deps, meeting.id)).toEqual({ status: "processed", newItems: 1, closes: 0 });
    expect(extractCalls[0]).toMatchObject({ transcript: TRANSCRIPT, user: { name: "Maruthi", aliases: ["Maru"] }, meeting: { title: "Banner sync" } });
    expect(store.meetings.get(meeting.id)?.processedAt).toBe(NOW.toISOString());
    expect(await store.listItems(user.id)).toHaveLength(1);
    expect(store.events).toContainEqual(expect.objectContaining({ type: "extract_run", tokensIn: 1000, tokensOut: 200, costInr: 1.2 }));
  });

  it("skips a meeting that is already processed", async () => {
    const { deps, meeting, extractCalls, wispr } = await setup();
    await processMeeting(deps, meeting.id);
    expect(await processMeeting(deps, meeting.id)).toEqual({ status: "skipped", reason: "already_processed" });
    expect(extractCalls).toHaveLength(1);
    expect(wispr.transcriptCalls).toHaveLength(1);
  });

  it("passes open items and drops closes for unknown items", async () => {
    const { deps, meeting, store, user, extractCalls } = await setup();
    await store.commitExtraction({ meetingId: "other", userId: user.id, newItems: [{ kind: "waiting", text: "Get logo", person: "Asha", quote: "q", meetingId: "other", dueAt: null }], closes: [], at: NOW.toISOString() });
    const [open] = await store.listItems(user.id, { status: "open" });
    deps.extract = async (input) => {
      extractCalls.push(input);
      return { newItems: [], closes: [{ itemId: open.id, quote: "Got the logo" }, { itemId: "made-up", quote: "x" }], usage: { inputTokens: 10, outputTokens: 5 } };
    };
    expect(await processMeeting(deps, meeting.id)).toEqual({ status: "processed", newItems: 0, closes: 1 });
    expect(extractCalls[0].openItems).toEqual([{ id: open.id, kind: "waiting", text: "Get logo", person: "Asha" }]);
    expect(store.items.get(open.id)).toMatchObject({ status: "done", closeQuote: "Got the logo", closedByMeetingId: meeting.id });
  });

  it("never passes the transcript to logEvent, even when extraction fails with it in the message", async () => {
    const { deps, store, user } = await setup();
    const logged: unknown[] = [];
    const orig = store.logEvent.bind(store);
    store.logEvent = async (e) => { logged.push(e); return orig(e); };
    await processPending(deps, user.id); // success path
    const { meeting: m2 } = await store.upsertMeeting({ userId: user.id, providerMeetingId: "p2", title: "Second", startedAt: "2026-11-25T10:00:00.000Z", participants: [] });
    deps.wispr = (uid) => ({ ...new FakeWispr().client(uid), getTranscript: async () => TRANSCRIPT });
    deps.extract = async (input) => { throw new Error(`model choked on: ${input.transcript}`); };
    const r = await processPending(deps, user.id);
    expect(r).toMatchObject({ processed: 0, failed: 1 });
    expect(store.meetings.get(m2.id)?.processedAt).toBeNull();
    expect(logged.some((e) => (e as { type: string }).type === "job_error")).toBe(true);
    const dump = JSON.stringify(logged);
    expect(dump).not.toContain("SECRET-TRANSCRIPT-MARKER");
    expect(dump).not.toContain("banner text by Friday");
  });

  it("an empty transcript marks the meeting processed without calling the model", async () => {
    const { deps, meeting, wispr, extractCalls, store } = await setup();
    wispr.transcripts.set("p1", "   ");
    expect(await processMeeting(deps, meeting.id)).toEqual({ status: "processed", newItems: 0, closes: 0 });
    expect(extractCalls).toHaveLength(0);
    expect(store.meetings.get(meeting.id)?.processedAt).not.toBeNull();
  });
});

describe("which open items a meeting may close", () => {
  it("offers only promises from earlier meetings, never decisions", async () => {
    const { deps, meeting, store, user, extractCalls, wispr } = await setup();
    const later = (await store.upsertMeeting({ userId: user.id, providerMeetingId: "p2", title: "Later", startedAt: "2026-11-25T11:00:00.000Z", participants: [] })).meeting;
    const earlier = (await store.upsertMeeting({ userId: user.id, providerMeetingId: "p0", title: "Earlier", startedAt: "2026-11-20T09:00:00.000Z", participants: [] })).meeting;
    wispr.transcripts.set("p2", "x");
    await store.commitExtraction({ meetingId: later.id, userId: user.id, at: NOW.toISOString(), closes: [], newItems: [{ kind: "owe", text: "From later", person: null, quote: "q", meetingId: later.id, dueAt: null }] });
    await store.commitExtraction({ meetingId: earlier.id, userId: user.id, at: NOW.toISOString(), closes: [], newItems: [
      { kind: "owe", text: "From earlier", person: null, quote: "q", meetingId: earlier.id, dueAt: null },
      { kind: "decision", text: "A decision", person: null, quote: "q", meetingId: earlier.id, dueAt: null },
    ] });
    await processMeeting(deps, meeting.id);
    expect(extractCalls[0].openItems.map((i) => i.text)).toEqual(["From earlier"]);
  });
});
