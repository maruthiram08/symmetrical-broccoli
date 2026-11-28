// "Include meetings others shared with me": listing, polling, reading and showing shared meetings.
// Wispr Flow is mocked throughout; the search_meetings rows follow the observed shape plus the
// documented shared=true / owner.name fields of a shared meeting.
import { describe, expect, it } from "vitest";
import { buildBrief } from "@/lib/brief/build";
import { renderMarkdown } from "@/lib/brief/markdown";
import { buildUserMessage } from "@/lib/extract/prompt";
import { keepSharedItems, speakerLabels, userSpeaks } from "@/lib/extract/shared";
import type { ExtractionResult } from "@/lib/types";
import { onboardingStep } from "@/server/local/onboarding";
import { MemoryStore } from "@/server/store";
import { connect, FakeWispr, fakeDeps, meeting } from "@/server/testing";
import { McpWisprClient, parseMeetings, type ToolCaller } from "@/server/wispr/client";
import { MemoryOAuthClientStore } from "@/server/wispr/oauth";
import { estimateRead } from "./estimate";
import { pollAll, pollUser } from "./poll";
import { processMeeting } from "./process";

const NOW = new Date("2026-11-25T12:00:00.000Z");
const text = (obj: unknown) => ({ content: [{ type: "text", text: JSON.stringify(obj) }] });

/** One search_meetings page with both kinds: own meetings (no shared field) and shared ones. */
const mixed = {
  meetings: [
    { id: "own-1", title: "Banner sync", finalized: true, has_transcript: true, attendees: [], start: "2026-11-25T09:00:00.000000Z", share_link: "https://notes.example/own-1" },
    { id: "sh-1", title: "Asha's planning", finalized: true, has_transcript: true, attendees: [{ name: "Asha" }], start: "2026-11-25T10:00:00.000000Z", shared: true, owner: { name: "Asha Rao" } },
    { id: "own-2", title: "Explicitly mine", start: "2026-11-25T08:00:00Z", shared: false, owner: { name: "Maruthi" } },
    { id: "sh-2", title: "Stringly shared", start: "2026-11-25T07:00:00Z", shared: "true" },
    { id: "sh-3", title: "Other flag", start: "2026-11-25T06:00:00Z", is_shared: true, owner: "Nitin" },
    { id: "own-3", title: "Odd value", start: "2026-11-25T05:00:00Z", shared: "no", owner: 42 },
  ],
  count: 6, has_more: false,
};

function mcpClient(respond: () => unknown) {
  const store = new MemoryStore();
  const user = store.addUser({ email: "a@b.c" });
  connect(store, user.id);
  const caller: ToolCaller = { callTool: async () => respond(), close: async () => {} };
  return new McpWisprClient(
    { userId: user.id, store, clients: new MemoryOAuthClientStore(), appUrl: "https://app.test", serverUrl: "https://mcp.test/mcp", now: () => NOW },
    { connect: async () => caller },
  );
}

describe("shared meetings in search_meetings", () => {
  it("tells own from shared defensively and keeps owner.name", () => {
    const r = parseMeetings(mixed);
    expect(Object.fromEntries(r.map((m) => [m.providerMeetingId, m.shared]))).toEqual({
      "own-1": false, "sh-1": true, "own-2": false, "sh-2": true, "sh-3": true, "own-3": false,
    });
    expect(r.find((m) => m.providerMeetingId === "sh-1")?.ownerName).toBe("Asha Rao");
    expect(r.find((m) => m.providerMeetingId === "sh-3")?.ownerName).toBe("Nitin");
    expect(r.find((m) => m.providerMeetingId === "own-2")).not.toHaveProperty("ownerName");
  });

  it("drops shared meetings by default and keeps them, marked, when asked", async () => {
    const off = await mcpClient(() => text(mixed)).listMeetingsSince("2026-11-25T00:00:00.000Z");
    expect(off.map((m) => m.providerMeetingId)).toEqual(["own-3", "own-2", "own-1"]);
    expect(off.every((m) => m.shared === undefined)).toBe(true);
    const on = await mcpClient(() => text(mixed)).listMeetingsSince("2026-11-25T00:00:00.000Z", { includeShared: true });
    expect(on.map((m) => m.providerMeetingId)).toEqual(["own-3", "sh-3", "sh-2", "own-2", "own-1", "sh-1"]);
    expect(on.find((m) => m.providerMeetingId === "sh-1")).toMatchObject({ shared: true, ownerName: "Asha Rao" });
  });
});

function pollSetup(includeShared: boolean) {
  const store = new MemoryStore();
  const wispr = new FakeWispr();
  const u = store.addUser({ email: "a@x.com", name: "Maruthi", ...(includeShared ? { includeShared } : {}) });
  connect(store, u.id);
  wispr.meetings.set(u.id, [
    meeting("own", "2026-11-25T09:00:00.000Z"),
    meeting("sh", "2026-11-25T10:00:00.000Z", { shared: true, ownerName: "Asha" }),
  ]);
  return { store, wispr, u, deps: { store, wispr: wispr.client, now: () => NOW } };
}

describe("pollUser and the setting", () => {
  it("leaves shared meetings out while the setting is off", async () => {
    const { store, wispr, u, deps } = pollSetup(false);
    expect(await pollUser(deps, u.id)).toMatchObject({ ok: true, found: 1, created: 1 });
    expect(wispr.sinceCalls[0]).not.toHaveProperty("includeShared");
    expect([...store.meetings.values()].map((m) => m.providerMeetingId)).toEqual(["own"]);
  });

  it("stores shared meetings marked as shared when it is on", async () => {
    const { store, wispr, u, deps } = pollSetup(true);
    expect(await pollUser(deps, u.id)).toMatchObject({ ok: true, found: 2, created: 2 });
    expect(wispr.sinceCalls[0].includeShared).toBe(true);
    const byId = Object.fromEntries([...store.meetings.values()].map((m) => [m.providerMeetingId, m]));
    expect(byId.own.shared).toBeUndefined();
    expect(byId.sh).toMatchObject({ shared: true, ownerName: "Asha" });
  });
});

describe("speaker matching", () => {
  it("reads speaker labels, with or without timestamps", () => {
    expect(speakerLabels("Asha: hi\n[00:01:02] Maruthi R: ok\n00:05 - Nitin: yes\nno label here\n12: not a name")).toEqual(["Asha", "Maruthi R", "Nitin"]);
  });
  it("matches the name or an alias as a whole word", () => {
    const u = { name: "Maruthi", aliases: ["MR"] };
    expect(userSpeaks("Asha: Maruthi will love it\nNitin: sure", u)).toBe(false);
    expect(userSpeaks("Asha: hi\nMR: on it", u)).toBe(true);
    expect(userSpeaks("Maruthi Reddy: on it", u)).toBe(true);
    expect(userSpeaks("Mrinal: on it", u)).toBe(false);
  });
});

const items: ExtractionResult["newItems"] = [
  { kind: "owe", text: "Send Asha the deck", person: "Asha", quote: "Maruthi will send the deck", dueAt: null },
  { kind: "waiting", text: "Share the payout calendar with Maruthi", person: "Nitin", quote: "I'll share it with Maruthi today", dueAt: null },
  { kind: "waiting", text: "Book the venue", person: "Nitin", quote: "I'll book the venue", dueAt: null },
  { kind: "decision", text: "Maru owns the launch checklist", person: null, quote: "Maru owns the checklist", dueAt: null },
  { kind: "decision", text: "Ship without the tooltip", person: null, quote: "ship it without the tooltip", dueAt: null },
];

describe("keepSharedItems", () => {
  const u = { name: "Maruthi", aliases: ["Maru"] };
  it("keeps only waiting items and decisions that name the user when the user doesn't speak", () => {
    const kept = keepSharedItems(items, "Asha: Maruthi will send the deck\nNitin: I'll share it with Maruthi today", u);
    expect(kept.map((i) => i.text)).toEqual(["Share the payout calendar with Maruthi", "Maru owns the launch checklist"]);
  });
  it("keeps everything when the user speaks", () => {
    expect(keepSharedItems(items, "Maru: I'll send the deck\nAsha: great", u)).toEqual(items);
  });
});

async function processSetup(transcript: string, opts: { includeShared?: boolean } = {}) {
  const store = new MemoryStore();
  const wispr = new FakeWispr();
  const user = store.addUser({ email: "a@x.com", name: "Maruthi", aliases: ["Maru"], includeShared: opts.includeShared ?? true });
  connect(store, user.id);
  const { meeting: m } = await store.upsertMeeting({ userId: user.id, providerMeetingId: "sh", title: "Asha's planning", startedAt: "2026-11-25T09:00:00.000Z", participants: ["Asha"], shared: true, ownerName: "Asha" });
  wispr.transcripts.set("sh", transcript);
  const f = fakeDeps({ store, wispr, now: NOW });
  f.deps.extract = async (input) => {
    f.extractCalls.push(input);
    return { newItems: items, closes: [], usage: { inputTokens: 100, outputTokens: 10 } };
  };
  return { store, wispr, user, m, ...f };
}

describe("processMeeting on a shared meeting", () => {
  it("never lets a shared meeting add to You owe when the user doesn't speak", async () => {
    const { deps, store, user, m, extractCalls } = await processSetup("Asha: Maruthi will send the deck\nNitin: I'll share it with Maruthi today");
    expect(await processMeeting(deps, m.id)).toEqual({ status: "processed", newItems: 2, closes: 0 });
    expect(extractCalls[0].meeting).toMatchObject({ shared: true, ownerName: "Asha" });
    const kinds = (await store.listItems(user.id)).map((i) => i.kind).sort();
    expect(kinds).toEqual(["decision", "waiting"]);
  });

  it("reads it like your own when you speak", async () => {
    const { deps, store, user, m } = await processSetup("Maruthi: I'll send the deck\nAsha: thanks");
    await processMeeting(deps, m.id);
    expect((await store.listItems(user.id)).filter((i) => i.kind === "owe")).toHaveLength(1);
  });

  it("skips the AI read when you're neither speaking nor named", async () => {
    const { deps, store, m, extractCalls } = await processSetup("Asha: venue?\nNitin: booked");
    expect(await processMeeting(deps, m.id)).toEqual({ status: "processed", newItems: 0, closes: 0 });
    expect(extractCalls).toHaveLength(0);
    expect(store.meetings.get(m.id)?.processedAt).toBe(NOW.toISOString());
  });

  it("closes out a shared meeting queued before the setting was turned off, without reading it", async () => {
    const { deps, m, extractCalls, wispr } = await processSetup("Maruthi: I'll send the deck", { includeShared: false });
    expect(await processMeeting(deps, m.id)).toEqual({ status: "processed", newItems: 0, closes: 0 });
    expect(extractCalls).toHaveLength(0);
    expect(wispr.transcriptCalls).toHaveLength(0);
  });

  it("tells the model whose notes these are", () => {
    const msg = buildUserMessage({
      transcript: "Asha: hi", user: { name: "Maruthi", aliases: [], timeZone: "Asia/Kolkata" },
      meeting: { title: "Planning", startedAt: NOW.toISOString(), participants: [], shared: true, ownerName: "Asha" }, openItems: [],
    });
    expect(msg).toContain("Recorded by: Asha, not the user.");
    const own = buildUserMessage({ transcript: "x", user: { name: "M", aliases: [], timeZone: "Asia/Kolkata" }, meeting: { title: "P", startedAt: NOW.toISOString(), participants: [] }, openItems: [] });
    expect(own).not.toContain("Recorded by");
  });

  it("marks shared-meeting items in the brief and the note", async () => {
    const { deps, store, user, m } = await processSetup("Asha: Maruthi will send the deck\nNitin: I'll share it with Maruthi today");
    await processMeeting(deps, m.id);
    const { meeting: own } = await store.upsertMeeting({ userId: user.id, providerMeetingId: "own", title: "Own sync", startedAt: "2026-11-25T08:00:00.000Z", participants: [] });
    await store.commitExtraction({ meetingId: own.id, userId: user.id, newItems: [{ kind: "waiting", text: "Get the logo", person: "Asha", quote: "I'll send the logo", meetingId: own.id, dueAt: null }], closes: [], at: NOW.toISOString() });
    const b = await buildBrief(store, user, NOW);
    expect(b.waitingOn.map((l) => [l.text, l.shared ?? false])).toEqual(expect.arrayContaining([["Share the payout calendar with Maruthi", true], ["Get the logo", false]]));
    const md = renderMarkdown(b);
    expect(md).toMatch(/Asha's planning, [^\n]* · shared/);
    expect(md).not.toMatch(/Own sync, [^\n]* · shared/);
  });
});

describe("estimateRead", () => {
  it("counts finished meetings with transcripts not read yet, and their cost", async () => {
    const store = new MemoryStore();
    const wispr = new FakeWispr();
    const u = store.addUser({ email: "a@x.com", name: "M" });
    connect(store, u.id);
    wispr.meetings.set(u.id, [
      meeting("a", "2026-11-20T09:00:00.000Z"),
      meeting("b", "2026-11-21T09:00:00.000Z"),
      meeting("rec", "2026-11-25T11:30:00.000Z", { finalized: false }),
      meeting("empty", "2026-11-22T09:00:00.000Z", { hasTranscript: false }),
      meeting("done", "2026-11-23T09:00:00.000Z"),
      meeting("sh", "2026-11-24T09:00:00.000Z", { shared: true }),
    ]);
    const { meeting: done } = await store.upsertMeeting({ userId: u.id, providerMeetingId: "done", title: "x", startedAt: "2026-11-23T09:00:00.000Z", participants: [] });
    await store.commitExtraction({ meetingId: done.id, userId: u.id, newItems: [], closes: [], at: NOW.toISOString() });
    const deps = { store, wispr: wispr.client, now: () => NOW };
    expect(await estimateRead(deps, u.id, "2026-11-18T00:00:00.000Z")).toEqual({ found: 5, shared: 0, toRead: 2, costInr: 7 });
    expect(await estimateRead(deps, u.id, "2026-11-18T00:00:00.000Z", { includeShared: true })).toEqual({ found: 6, shared: 1, toRead: 3, costInr: 11 });
  });
});

describe("onboardingStep", () => {
  it("walks name, connect, read, done", () => {
    const store = new MemoryStore();
    const nameless = store.addUser({ email: "a@x.com" });
    expect(onboardingStep(null, null, false)).toBe("about");
    expect(onboardingStep(nameless, null, false)).toBe("about");
    const u = { ...nameless, name: "Maruthi" };
    expect(onboardingStep(u, null, false)).toBe("connect");
    const c = connect(store, u.id);
    expect(onboardingStep(u, c, false)).toBe("read");
    expect(onboardingStep(u, c, true)).toBe("done");
    expect(onboardingStep(u, { ...c, lastSeenAt: NOW.toISOString() }, false)).toBe("done");
  });
});

describe("pollAll while onboarding", () => {
  it("waits for the first read to be started from /welcome", async () => {
    const { store, wispr, u, deps } = pollSetup(false);
    expect(await pollAll(deps, { waitForFirstRead: true })).toEqual([]);
    expect(wispr.sinceCalls).toHaveLength(0);
    await pollUser(deps, u.id, { since: "2026-11-20T00:00:00.000Z" }); // the first read
    expect(store.connections.get(u.id)?.lastSeenAt).not.toBeNull();
    expect(await pollAll(deps, { waitForFirstRead: true })).toHaveLength(1);
  });
});
