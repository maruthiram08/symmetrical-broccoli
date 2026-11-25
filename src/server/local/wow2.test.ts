import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildBrief } from "@/lib/brief/build";
import type { UpcomingMeeting } from "@/lib/types";
import { cacheUpcoming, pollUser } from "@/server/jobs/poll";
import { MemoryStore } from "@/server/store";
import { connect, FakeWispr, meeting } from "@/server/testing";
import { McpWisprClient, parseUpcoming, type ToolCaller, type WisprClient } from "@/server/wispr/client";
import { MemoryOAuthClientStore } from "@/server/wispr/oauth";
import { FileStore } from "./file-store";
import { notifyPrep, prepCard } from "./prep";

const NOW = new Date("2026-11-25T08:30:00.000Z");
const soon = (min: number, extra: Partial<UpcomingMeeting> = {}): UpcomingMeeting => ({
  calendarId: `cal-${min}`, title: "Design crit", startsAt: new Date(NOW.getTime() + min * 60_000).toISOString(), attendees: ["Nitin Kumar"], ...extra,
});

describe("FileStore migration", () => {
  it("loads a state.json written before upcoming meetings existed, then round-trips the new fields", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "db-wow2-")), ".daily-brief");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "state.json");
    const old = {
      version: 1,
      users: [{ id: "u1", email: "you@this-mac", name: "Maruthi", aliases: [], timeZone: "Asia/Kolkata", briefTime: "18:00", createdAt: "2026-11-01T00:00:00Z" }],
      connections: [], items: [], briefs: [], oauthClients: [], events: [],
      meetings: [{ id: "m1", userId: "u1", providerMeetingId: "p1", title: "Standup", startedAt: "2026-11-25T05:30:00.000Z", participants: [], processedAt: null }],
    };
    writeFileSync(path, JSON.stringify(old));
    const a = new FileStore(path);
    expect(await a.getUpcoming("u1")).toBeNull();
    expect((await a.getMeeting("m1"))?.link).toBeUndefined();

    await a.saveUpcoming("u1", { fetchedAt: NOW.toISOString(), meetings: [soon(20)] });
    expect(await a.markPrepNotified("u1:cal-20:x")).toBe(true);
    const b = new FileStore(path);
    expect((await b.getUpcoming("u1"))?.meetings[0].calendarId).toBe("cal-20");
    expect(await b.markPrepNotified("u1:cal-20:x")).toBe(false);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved.version).toBe(1);
    expect(saved.meetings[0].title).toBe("Standup");
  });
});

describe("poll caches upcoming meetings", () => {
  function setup(listUpcoming?: WisprClient["listUpcoming"]) {
    const store = new MemoryStore();
    const wispr = new FakeWispr();
    const u = store.addUser({ email: "a@x.com", name: "Maruthi" });
    connect(store, u.id);
    wispr.meetings.set(u.id, [meeting("m1", "2026-11-25T05:00:00.000Z", { link: "https://notes.wisprflow.ai/shared/abc" })]);
    const client = (id: string): WisprClient => ({ ...wispr.client(id), ...(listUpcoming ? { listUpcoming } : {}) });
    return { store, u, deps: { store, wispr: client, now: () => NOW } };
  }

  it("stores the next hour's meetings (and the meeting link) during the poll", async () => {
    const calls: number[] = [];
    const { store, u, deps } = setup(async (h) => { calls.push(h); return [soon(-5), soon(20), soon(90)]; });
    expect(await pollUser(deps, u.id)).toMatchObject({ ok: true, created: 1 });
    expect(calls).toEqual([1]);
    expect((await store.getUpcoming(u.id))?.meetings.map((m) => m.calendarId)).toEqual(["cal-20"]);
    expect([...store.meetings.values()][0].link).toBe("https://notes.wisprflow.ai/shared/abc");
  });

  it("never breaks the poll when the tool fails, and keeps the last cache", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { store, u, deps } = setup(async () => { throw new Error("tool not found"); });
    await store.saveUpcoming(u.id, { fetchedAt: "earlier", meetings: [soon(20)] });
    expect(await pollUser(deps, u.id)).toMatchObject({ ok: true, created: 1 });
    expect((await store.getUpcoming(u.id))?.fetchedAt).toBe("earlier");
    expect(err.mock.calls.some((c) => String(c[0]).includes("[upcoming]"))).toBe(true);
    err.mockRestore();
  });

  it("does nothing for a client without the tool", async () => {
    const { store, u, deps } = setup();
    expect(await pollUser(deps, u.id)).toMatchObject({ ok: true });
    expect(await store.getUpcoming(u.id)).toBeNull();
  });

  it("calls list_upcoming_meetings through the MCP client with window_hours", async () => {
    const store = new MemoryStore();
    const u = store.addUser({ email: "a@b.c" });
    connect(store, u.id);
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const payload = { events: [{ calendar_id: "evt-1", title: "Design crit", start: soon(20).startsAt, attendees: [{ name: "Nitin Kumar", email: "n@x.io" }, { email: "priya@x.io" }], attendee_count: 2 }], has_more: false };
    const caller: ToolCaller = { callTool: async (name, args) => { calls.push({ name, args }); return { content: [{ type: "text", text: JSON.stringify(payload) }] }; }, close: async () => {} };
    const client = new McpWisprClient(
      { userId: u.id, store, clients: new MemoryOAuthClientStore(), appUrl: "https://app.test", serverUrl: "https://mcp.test/mcp", now: () => NOW },
      { connect: async () => caller },
    );
    await cacheUpcoming(store, u.id, client, NOW);
    expect(calls).toEqual([{ name: "list_upcoming_meetings", args: { window_hours: 1, limit: 50 } }]);
    expect((await store.getUpcoming(u.id))?.meetings).toEqual([{ calendarId: "evt-1", title: "Design crit", startsAt: soon(20).startsAt, attendees: ["Nitin Kumar", "priya@x.io"] }]);
  });

  it("parses other plausible shapes and skips junk", () => {
    expect(parseUpcoming({ meetings: [{ id: 3, summary: "1:1", start: { dateTime: "2026-11-25T09:00:00Z" } }, { title: "no id", start: "2026-11-25T09:00:00Z" }, { id: "x" }] }))
      .toEqual([{ calendarId: "3", title: "1:1", startsAt: "2026-11-25T09:00:00.000Z", attendees: [] }]);
    expect(parseUpcoming("nope")).toEqual([]);
  });
});

describe("prep card and notification", () => {
  async function seeded() {
    const store = new MemoryStore();
    const u = store.addUser({ email: "a@x.com", name: "Maruthi", timeZone: "Asia/Kolkata" });
    const { meeting: m } = await store.upsertMeeting({ userId: u.id, providerMeetingId: "p", title: "Standup", startedAt: "2026-11-25T05:00:00.000Z", participants: [], link: "https://notes.wisprflow.ai/shared/abc" });
    await store.commitExtraction({ meetingId: m.id, userId: u.id, at: "2026-11-25T05:30:00.000Z", closes: [], newItems: [
      { kind: "owe", text: "Send Nitin the banner", person: "Nitin", quote: "I'll send it", meetingId: m.id, dueAt: null },
      { kind: "waiting", text: "Priya shares the deck", person: "Priya", quote: "I'll share it", meetingId: m.id, dueAt: null },
    ] });
    return { store, u, m };
  }

  it("shows the next meeting with what's open with its people", async () => {
    const { store, u } = await seeded();
    expect(await prepCard(store, u, NOW)).toBeNull();
    await store.saveUpcoming(u.id, { fetchedAt: NOW.toISOString(), meetings: [soon(20)] });
    const p = await prepCard(store, u, NOW);
    expect(p?.owe.map((i) => i.text)).toEqual(["Send Nitin the banner"]);
    expect(p?.waiting).toEqual([]);
  });

  it("notifies once, about ten minutes before", async () => {
    const { store, u } = await seeded();
    await store.saveUpcoming(u.id, { fetchedAt: NOW.toISOString(), meetings: [soon(25), soon(9, { calendarId: "c9", attendees: ["Priya Shah", "Maruthi"] })] });
    const sent: Array<[string, string]> = [];
    const notify = (t: string, b: string) => { sent.push([t, b]); };
    expect(await notifyPrep(store, NOW, notify)).toBe(1);
    expect(await notifyPrep(store, NOW, notify)).toBe(0);
    expect(sent).toEqual([["Next: Design crit at 2:09 PM", "With Priya Shah: 1 waiting"]]);
  });

  it("gives brief lines the meeting id and quote peek details", async () => {
    const { store, u, m } = await seeded();
    const b = await buildBrief(store, u, NOW);
    expect(b.youOwe[0]).toMatchObject({ meetingId: m.id, peek: { speaker: "You", when: "Wed 25 Nov, 10:30 AM", link: "https://notes.wisprflow.ai/shared/abc" } });
    expect(b.waitingOn[0].peek?.speaker).toBe("Priya");
  });
});
