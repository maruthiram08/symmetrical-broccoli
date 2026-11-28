import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CalendarEvent } from "@/lib/types";
import { FileStore } from "@/server/local/file-store";
import { renderMarkdown } from "@/lib/brief/markdown";
import { dueHintsFor, withTomorrow } from "@/server/local/calendar";
import { MemoryStore } from "@/server/store";
import { connect, emptyBrief, FakeWispr, meeting } from "@/server/testing";
import { McpWisprClient, type ToolCaller, type WisprClient } from "@/server/wispr/client";
import { listMeetingSeries, parseEvent, searchCalendarEvents } from "@/server/wispr/calendar";
import { MemoryOAuthClientStore } from "@/server/wispr/oauth";
import { cacheCalendar, CALENDAR_REFRESH_MS, SERIES_CHECKS_PER_REFRESH } from "./calendar";
import { pollUser } from "./poll";

const NOW = new Date("2026-11-25T12:30:00.000Z"); // 6:00 PM IST
const text = (obj: unknown) => ({ content: [{ type: "text", text: JSON.stringify(obj) }] });

afterEach(() => vi.restoreAllMocks());

describe("Wispr Flow calendar tools (mocked: response shapes are guesses, not observed)", () => {
  it("parses several plausible event shapes and drops all-day, cancelled and junk rows", () => {
    expect(parseEvent({ calendar_id: "c1", title: "Standup", start: "2026-11-26T05:00:00Z", end: "2026-11-26T05:15:00Z", attendees: [{ name: "Arjun Mehta", email: "a@x.com" }, { email: "room@x.com", resource: true }], attendee_count: 2 }))
      .toEqual({ calendarId: "c1", title: "Standup", startsAt: "2026-11-26T05:00:00.000Z", endsAt: "2026-11-26T05:15:00.000Z", attendees: ["Arjun Mehta"], recurringId: null, attendeeCount: 2 });
    expect(parseEvent({ id: 7, summary: "1:1", start: { dateTime: "2026-11-26T16:00:00+05:30" }, end: { dateTime: "2026-11-26T15:00:00+05:30" }, recurring_event_id: "r1" }))
      .toMatchObject({ calendarId: "7", title: "1:1", startsAt: "2026-11-26T10:30:00.000Z", endsAt: null, recurringId: "r1" });
    expect(parseEvent({ id: "x", start: { date: "2026-11-26" } })).toBeNull();
    expect(parseEvent({ id: "x", start: "2026-11-26" })).toBeNull();
    expect(parseEvent({ id: "x", start: "2026-11-26T05:00:00Z", status: "cancelled" })).toBeNull();
    expect(parseEvent({ title: "no id", start: "2026-11-26T05:00:00Z" })).toBeNull();
    expect(parseEvent("junk")).toBeNull();
  });

  it("pages search_calendar_events and fills in full attendee lists with get_calendar_event", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const store = new MemoryStore();
    const user = store.addUser({ email: "a@b.c" });
    connect(store, user.id);
    const caller: ToolCaller = {
      callTool: async (name, args) => {
        calls.push({ name, args });
        if (name === "search_calendar_events" && !args.cursor) return text({ events: [{ calendar_id: "big", title: "All hands", start: "2026-11-26T09:00:00Z", attendees: [{ name: "A" }], attendee_count: 3 }], has_more: true, next_cursor: "c2" });
        if (name === "search_calendar_events") return { structuredContent: { events: [{ calendar_id: "s", title: "Standup", start: "2026-11-26T05:00:00Z" }, { calendar_id: "out", title: "Out of range", start: "2026-12-26T05:00:00Z" }], has_more: false } };
        if (name === "get_calendar_event") return text({ calendar_id: "big", title: "All hands", start: "2026-11-26T09:00:00Z", attendees: [{ name: "A" }, { name: "B" }, { name: "C" }] });
        throw new Error(`unexpected ${name}`);
      },
      close: async () => {},
    };
    const client = new McpWisprClient(
      { userId: user.id, store, clients: new MemoryOAuthClientStore(), appUrl: "https://app.test", serverUrl: "https://mcp.test/mcp", now: () => NOW },
      { connect: async () => caller },
    );
    const events = await client.searchCalendar("2026-11-25T18:30:00.000Z", "2026-11-26T18:30:00.000Z");
    expect(events.map((e) => e.calendarId)).toEqual(["s", "big"]);
    expect(events[1].attendees).toEqual(["A", "B", "C"]);
    expect(calls[0]).toEqual({ name: "search_calendar_events", args: { since: "2026-11-25T18:30:00.000Z", until: "2026-11-26T18:30:00.000Z", limit: 200 } });
    expect(calls[1].args.cursor).toBe("c2");
    expect(calls[2]).toEqual({ name: "get_calendar_event", args: { calendar_id: "big" } });
  });

  it("reads list_meeting_series: not recurring, and pages of occurrences", async () => {
    expect(await listMeetingSeries(async () => ({ recurring: false, reason: "not_recurring", meetings: [] }), "p1")).toBeNull();
    const pages = [
      { recurring: true, meetings: [{ id: "p2", title: "Standup", start: "2026-11-24T05:30:00Z" }], has_more: true, next_cursor: "n" },
      { meetings: [{ id: "p1", title: "Standup", start: "2026-11-25T05:30:00Z" }, { nope: 1 }], has_more: false },
    ];
    const args: unknown[] = [];
    const r = await listMeetingSeries(async (_n, a) => { args.push(a); return pages.shift(); }, "p1");
    expect(r?.occurrences.map((o) => o.providerMeetingId).sort()).toEqual(["p1", "p2"]);
    expect(args).toEqual([{ meeting_id: "p1", limit: 200 }, { meeting_id: "p1", limit: 200, cursor: "n" }]);
  });

  it("keeps the preview when get_calendar_event fails", async () => {
    const events = await searchCalendarEvents(async (name) => {
      if (name === "get_calendar_event") throw new Error("boom");
      return { events: [{ id: "e", start: "2026-11-26T05:00:00Z", attendees: ["A"], attendee_count: 4 }] };
    }, "2026-11-25T00:00:00Z", "2026-11-27T00:00:00Z");
    expect(events[0].attendees).toEqual(["A"]);
  });
});

function fakeCalendarClient(over: Partial<WisprClient> = {}) {
  const calls = { search: [] as Array<[string, string]>, series: [] as string[] };
  const client: WisprClient = {
    listMeetingsSince: async () => [],
    getTranscript: async () => "",
    searchCalendar: async (a, b) => {
      calls.search.push([a, b]);
      return [{ calendarId: "su", title: "Standup", startsAt: "2026-11-26T05:00:00.000Z", endsAt: null, attendees: ["Arjun Mehta"] }];
    },
    listSeries: async (id) => {
      calls.series.push(id);
      if (id === "solo") return null;
      return { occurrences: [{ providerMeetingId: "p1", title: "Standup", startedAt: "2026-11-24T05:30:00.000Z" }, { providerMeetingId: "p2", title: "Standup", startedAt: "2026-11-25T05:30:00.000Z" }], recurringId: null };
    },
    ...over,
  };
  return { client, calls };
}

describe("calendar cache", () => {
  const user = { id: "u1", timeZone: "Asia/Kolkata" };

  it("caches 8 days of events from local midnight and series, then waits 30 minutes", async () => {
    const store = new MemoryStore();
    const { client, calls } = fakeCalendarClient();
    expect(await cacheCalendar(store, user, client, NOW, ["p2", "solo", "p1"])).toBe(true);
    const c = (await store.getCalendar("u1"))!;
    expect(calls.search).toEqual([["2026-11-24T18:30:00.000Z", "2026-12-02T18:30:00.000Z"]]);
    expect(c.fetchedAt).toBe(NOW.toISOString());
    expect(c.nextFetchAt).toBe(new Date(NOW.getTime() + CALENDAR_REFRESH_MS).toISOString());
    expect(c.events.map((e) => e.calendarId)).toEqual(["su"]);
    expect(c.series).toHaveLength(1);
    expect(c.seriesChecked).toEqual({ p1: c.series[0].id, p2: c.series[0].id, solo: null });
    expect(calls.series).toEqual(["p2", "solo"]); // p1 came back with p2: no second call

    expect(await cacheCalendar(store, user, client, new Date(NOW.getTime() + 29 * 60_000), ["new"])).toBe(false);
    expect(calls.search).toHaveLength(1);
    expect(await cacheCalendar(store, user, client, new Date(NOW.getTime() + 30 * 60_000), ["new"])).toBe(true);
    expect(calls.search).toHaveLength(2);
    expect(calls.series).toEqual(["p2", "solo", "new"]);
  });

  it("limits list_meeting_series calls per refresh", async () => {
    const store = new MemoryStore();
    const { client, calls } = fakeCalendarClient({ listSeries: async (id) => { calls.series.push(id); return null; } });
    const ids = Array.from({ length: 20 }, (_, i) => `m${i}`);
    await cacheCalendar(store, user, client, NOW, ids);
    expect(calls.series).toEqual(ids.slice(0, SERIES_CHECKS_PER_REFRESH));
  });

  it("logs failures to stderr, keeps old events, and still waits 30 minutes", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = new MemoryStore();
    await cacheCalendar(store, user, fakeCalendarClient().client, NOW, []);
    const later = new Date(NOW.getTime() + 31 * 60_000);
    const broken = fakeCalendarClient({
      searchCalendar: async () => { throw new Error("wispr down"); },
      listSeries: async () => { throw new Error("network"); },
    });
    expect(await cacheCalendar(store, user, broken.client, later, ["a", "b"])).toBe(true);
    const c = (await store.getCalendar("u1"))!;
    expect(c.events.map((e) => e.calendarId)).toEqual(["su"]);
    expect(c.fetchedAt).toBe(NOW.toISOString());
    expect(c.seriesChecked).toEqual({}); // a network error is retried next time
    expect(Date.parse(c.nextFetchAt)).toBe(later.getTime() + CALENDAR_REFRESH_MS);
    expect(err.mock.calls.map((a) => String(a[0]))).toEqual([expect.stringContaining("[calendar] events"), expect.stringContaining("[calendar] series")]);
  });

  it("marks a meeting the series tool rejects as checked", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const store = new MemoryStore();
    const { client } = fakeCalendarClient({ listSeries: async () => { throw new Error("Wispr Flow list_meeting_series returned an error: unknown meeting"); } });
    await cacheCalendar(store, user, client, NOW, ["gone", "also"]);
    expect((await store.getCalendar("u1"))!.seriesChecked).toEqual({ gone: null, also: null });
  });

  it("does nothing for a client or store without the calendar tools", async () => {
    const store = new MemoryStore();
    expect(await cacheCalendar(store, user, { listMeetingsSince: async () => [], getTranscript: async () => "" }, NOW)).toBe(false);
    expect(await store.getCalendar("u1")).toBeNull();
  });

  it("never breaks the poll", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = new MemoryStore();
    const wispr = new FakeWispr();
    const u = store.addUser({ email: "a@x.com", name: "Maruthi" });
    connect(store, u.id);
    wispr.meetings.set(u.id, [meeting("p1", "2026-11-25T05:30:00.000Z")]);
    const client = (id: string): WisprClient => ({
      ...wispr.client(id),
      searchCalendar: async () => { throw new Error("calendar down"); },
      listSeries: async () => { throw new Error("series down"); },
    });
    const r = await pollUser({ store, wispr: client, now: () => NOW }, u.id);
    expect(r).toMatchObject({ ok: true, found: 1, created: 1 });
    expect(err).toHaveBeenCalled();
    expect(store.events.filter((e) => e.type === "job_error")).toEqual([]);
  });

  it("checks the poll's meetings for a series, newest first", async () => {
    const store = new MemoryStore();
    const wispr = new FakeWispr();
    const u = store.addUser({ email: "a@x.com", name: "Maruthi" });
    connect(store, u.id);
    wispr.meetings.set(u.id, [meeting("p1", "2026-11-24T05:30:00.000Z"), meeting("p2", "2026-11-25T05:30:00.000Z")]);
    const { client: cal, calls } = fakeCalendarClient();
    await pollUser({ store, wispr: (id) => ({ ...wispr.client(id), searchCalendar: cal.searchCalendar, listSeries: cal.listSeries }), now: () => NOW }, u.id);
    expect(calls.series).toEqual(["p2"]);
    expect((await store.getCalendar(u.id))!.series[0].providerMeetingIds).toEqual(["p1", "p2"]);
  });
});

describe("stores", () => {
  it("FileStore round-trips the calendar cache, loads files without it, and sets a due", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "db-cal-")), "state.json");
    writeFileSync(path, JSON.stringify({
      version: 1, users: [{ id: "u1", email: "x", name: "M", aliases: [], timeZone: "Asia/Kolkata", briefTime: "18:00", createdAt: "" }],
      connections: [], meetings: [], briefs: [], oauthClients: [], events: [],
      items: [{ id: "i1", userId: "u1", kind: "owe", text: "t", person: "Nitin", quote: "", meetingId: "m", dueAt: null, status: "open", closedByMeetingId: null, closeQuote: null, createdAt: "", closedAt: null }],
    }));
    const a = new FileStore(path);
    expect(await a.getCalendar("u1")).toBeNull();
    const ev: CalendarEvent = { calendarId: "c", title: "Standup", startsAt: "2026-11-26T05:00:00.000Z", endsAt: null, attendees: [] };
    await a.saveCalendar("u1", { fetchedAt: NOW.toISOString(), nextFetchAt: NOW.toISOString(), fromIso: "", toIso: "", events: [ev], series: [], seriesChecked: { p: null } });
    expect(await a.setItemDue("u1", "i1", "2026-11-26T05:00:00.000Z")).toBe(true);
    expect(await a.setItemDue("someone-else", "i1", null)).toBe(false);
    const b = new FileStore(path);
    expect((await b.getCalendar("u1"))?.events[0].title).toBe("Standup");
    expect((await b.listItems("u1"))[0].dueAt).toBe("2026-11-26T05:00:00.000Z");
  });

  it("adds tomorrow's meetings to the brief only once the calendar has been read", async () => {
    const store = new MemoryStore();
    const u = store.addUser({ email: "a@x.com", name: "Maruthi" });
    const brief = emptyBrief(u, "2026-11-25");
    expect((await withTomorrow(store, u, NOW, brief)).tomorrow).toBeUndefined();
    await cacheCalendar(store, u, fakeCalendarClient().client, NOW, []);
    const withIt = await withTomorrow(store, u, NOW, brief);
    expect(withIt.tomorrow?.map((m) => [m.time, m.title])).toEqual([["10:30 AM", "Standup"]]);
  });

  it("degrades to nothing when Wispr Flow returns no events", async () => {
    const store = new MemoryStore();
    const u = store.addUser({ email: "a@x.com", name: "Maruthi" });
    store.items.set("i", { id: "i", userId: u.id, kind: "owe", text: "t", person: "Nitin", quote: "", meetingId: "m", dueAt: null, status: "open", closedByMeetingId: null, closeQuote: null, createdAt: "", closedAt: null });
    // live shape for a user with no calendar events visible
    const call = async () => ({ events: [], count: 0, has_more: false });
    const { client } = fakeCalendarClient({ searchCalendar: (a, b) => searchCalendarEvents(call, a, b) });
    await cacheCalendar(store, u, client, NOW, []);
    expect((await store.getCalendar(u.id))?.events).toEqual([]);
    const brief = await withTomorrow(store, u, NOW, emptyBrief(u, "2026-11-25"));
    expect(brief.tomorrow).toBeUndefined();
    expect(renderMarkdown(brief)).not.toContain("Tomorrow");
    expect((await dueHintsFor(store, u, NOW)).size).toBe(0);
  });
});
