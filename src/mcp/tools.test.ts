import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it } from "vitest";
import type { Item } from "@/lib/types";
import { FileStore } from "@/server/local/file-store";
import { createMcpServer, decisions, listOpen, markItem, person, searchItems, today, type ToolContext } from "./tools";

// Wednesday 25 Nov 2026, 3:30 PM in Kolkata.
const NOW = new Date("2026-11-25T10:00:00Z");

interface Seeded { path: string; ctx: ToolContext; ids: Record<string, string> }

/** A temp state.json with one user, three meetings and a spread of items. */
async function seed(): Promise<Seeded> {
  const path = join(mkdtempSync(join(tmpdir(), "db-mcp-")), ".daily-brief", "state.json");
  const store = new FileStore(path);
  const u = store.addUser({ email: "you@this-mac", name: "Maruthi", aliases: ["Maru"], timeZone: "Asia/Kolkata" });
  const meet = async (p: string, title: string, startedAt: string, participants: string[]) =>
    (await store.upsertMeeting({ userId: u.id, providerMeetingId: p, title, startedAt, participants })).meeting;
  const old = await meet("m1", "Dividend sync", "2026-11-20T06:00:00Z", ["Tarun Mehta", "Nitin K"]);
  const mid = await meet("m2", "Banner review", "2026-11-24T06:00:00Z", ["Tarun Mehta"]);
  const tod = await meet("m3", "Standup", "2026-11-25T04:00:00Z", ["Nitin K", "Priya"]);
  const it = (kind: Item["kind"], text: string, person: string | null, quote: string, meetingId: string, dueAt: string | null = null) =>
    ({ kind, text, person, quote, meetingId, dueAt });
  await store.commitExtraction({ meetingId: old.id, userId: u.id, at: "2026-11-20T07:00:00Z", closes: [], newItems: [
    it("owe", "Send Tarun the dividend banner copy", "Tarun Mehta", "I'll send you the banner copy", old.id, "2026-11-21T12:30:00Z"),
    it("decision", "Show the dividend banner only to holders", null, "let's only show the banner to holders", old.id),
    it("waiting", "Nitin to share the payout calendar", "Nitin K", "I'll share the payout calendar", old.id),
  ] });
  await store.commitExtraction({ meetingId: mid.id, userId: u.id, at: "2026-11-24T07:00:00Z", closes: [], newItems: [
    it("owe", "Review Tarun's onboarding deck", "Tarun", "can you review my deck", mid.id),
    it("decision", "Ship the banner on Friday", null, "we ship Friday", mid.id),
  ] });
  const items = await store.listItems(u.id);
  const id = (t: string) => items.find((i) => i.text.startsWith(t))!.id;
  await store.commitExtraction({ meetingId: tod.id, userId: u.id, at: "2026-11-25T05:00:00Z",
    closes: [{ itemId: id("Nitin to share"), quote: "shared the payout calendar this morning" }],
    newItems: [
      it("owe", "Book the offsite venue", "Priya", "I'll book the venue today", tod.id, "2026-11-25T12:30:00Z"),
      it("decision", "Move standup to 9:30", null, "standup at 9:30 from Monday", tod.id),
    ] });
  const all = await store.listItems(u.id);
  const ids = Object.fromEntries(all.map((i) => [i.text.split(" ").slice(0, 2).join(" "), i.id]));
  // A separate copy, like the MCP process next to the web app.
  return { path, ctx: { store: new FileStore(path), now: () => NOW }, ids };
}

let s: Seeded;
beforeEach(async () => { s = await seed(); });

describe("list_open", () => {
  it("lists every open item by kind with id, person, due, meeting and quote", async () => {
    const out = await listOpen(s.ctx, {});
    expect(out).toContain("## You owe (3)");
    expect(out).toContain(`[${s.ids["Send Tarun"]}] You owe · Tarun Mehta · due 21 Nov 2026 (3d late)`);
    expect(out).toContain(`Dividend sync, 20 Nov 2026 · "I'll send you the banner copy"`);
    expect(out).toContain("## Decisions (3)");
    expect(out).not.toContain("payout calendar"); // closed
  });
  it("filters by kind and fuzzy person", async () => {
    const out = await listOpen(s.ctx, { kind: "owe", person: "tarun" });
    expect(out).toContain("Send Tarun the dividend banner copy");
    expect(out).toContain("Review Tarun's onboarding deck");
    expect(out).not.toContain("offsite");
    expect(out).not.toContain("Decision");
    expect(await listOpen(s.ctx, { kind: "waiting" })).toBe("Nothing open.");
    expect(await listOpen(s.ctx, { person: "Zed" })).toMatch(/Nobody called "Zed".*Tarun Mehta/);
  });
});

describe("person", () => {
  it("shows what you owe them, what closed, and decisions together", async () => {
    const out = await person(s.ctx, { name: "Tarun" });
    expect(out).toMatch(/^# Tarun Mehta \(also written Tarun\)/);
    expect(out).toContain("You owe 2 · they owe you 0 · 1 overdue");
    expect(out).toContain("Show the dividend banner only to holders");
    const nitin = await person(s.ctx, { name: "nitin" });
    expect(nitin).toContain("## Closed in the last 30 days (1)");
    expect(nitin).toContain(`Closed in Standup, 25 Nov 2026: "shared the payout calendar this morning"`);
  });
  it("never treats you as a person", async () => {
    expect(await person(s.ctx, { name: "Maruthi" })).toMatch(/^Nobody called/);
  });
});

describe("search", () => {
  it("finds open items by word start and hides closed ones unless asked", async () => {
    const out = await searchItems(s.ctx, { query: "ban" });
    expect(out).toContain("Send Tarun the dividend banner copy");
    expect(out).toContain("## Meetings\n- Banner review, 24 Nov 2026 (with Tarun Mehta)");
    expect(await searchItems(s.ctx, { query: "payout" })).toBe('Nothing matches "payout" in open items (try include_closed: true).');
    const closed = await searchItems(s.ctx, { query: "payout", include_closed: true });
    expect(closed).toContain("Waiting on (done) · Nitin K");
  });
});

describe("decisions", () => {
  it("newest first, by topic, and since a date", async () => {
    const all = await decisions(s.ctx, {});
    expect(all.indexOf("Move standup")).toBeLessThan(all.indexOf("Ship the banner"));
    const banner = await decisions(s.ctx, { query: "dividend banner" });
    expect(banner).toMatch(/Decisions about "dividend banner", best match first \(\d\)\n\[[^\]]+\] Decision\n  Show the dividend banner only to holders/);
    expect(banner).toContain(`"let's only show the banner to holders"`);
    const since = await decisions(s.ctx, { since: "2026-11-24" });
    expect(since).toContain("Ship the banner");
    expect(since).not.toContain("holders");
  });
});

describe("today", () => {
  it("matches the Today brief", async () => {
    const out = await today(s.ctx);
    expect(out).toMatch(/^# Wednesday, 25 November\nFrom 1 meeting today\./);
    expect(out).toContain(`[${s.ids["Book the"]}] You owe · Priya · due Today 6:00 PM`);
    expect(out).toContain("## Decisions (1)\n");
    expect(out).toContain("## Closed today (1)");
    expect(out).toContain("Send Tarun the dividend banner copy"); // overdue, due by tomorrow
    expect(out).toContain("Still open from before");
  });
});

describe("mark_item", () => {
  it("writes through FileStore so another copy (the web app) sees it, and undoes", async () => {
    const web = new FileStore(s.path);
    const id = s.ids["Book the"];
    const r = await markItem(s.ctx, { id, status: "done" });
    expect(r.isError).toBeUndefined();
    expect(r.text).toMatch(/^Marked done:\n\[.+\] You owe \(done\) · Priya/);
    const u = (await web.listUsers())[0];
    expect((await web.listItems(u.id)).find((i) => i.id === id)?.status).toBe("done");
    expect(JSON.parse(readFileSync(s.path, "utf8")).items.find((i: Item) => i.id === id).closedAt).toBe(NOW.toISOString());

    // the web app writes something else in between; the MCP copy picks it up before its next write
    await web.setItemStatus(s.ids["Review Tarun's"], "wrong", NOW.toISOString());
    await new Promise((r) => setTimeout(r, 5));
    expect((await markItem(s.ctx, { id: id.slice(0, 8), status: "open" })).text).toMatch(/^Reopened/);
    const after = await new FileStore(s.path).listItems(u.id);
    expect(after.find((i) => i.id === id)?.status).toBe("open");
    expect(after.find((i) => i.id === s.ids["Review Tarun's"])?.status).toBe("wrong");
  });
  it("rejects unknown ids", async () => {
    expect(await markItem(s.ctx, { id: "nope-nope", status: "done" })).toMatchObject({ isError: true });
  });
});

describe("before setup", () => {
  it("says so instead of failing", async () => {
    const ctx = { store: new FileStore(join(mkdtempSync(join(tmpdir(), "db-mcp-")), "state.json")) };
    expect(await today(ctx)).toMatch(/isn't set up yet/);
  });
});

describe("MCP round trip", () => {
  it("lists the six tools and calls them over an in-memory transport", async () => {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer(s.ctx);
    await server.connect(serverT);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientT);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["decisions", "list_open", "mark_item", "person", "search", "today"]);
    expect(tools.find((t) => t.name === "list_open")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "mark_item")?.annotations?.readOnlyHint).toBe(false);

    const r = await client.callTool({ name: "person", arguments: { name: "Tarun" } });
    expect((r.content as Array<{ text: string }>)[0].text).toContain("Send Tarun the dividend banner copy");

    const m = await client.callTool({ name: "mark_item", arguments: { id: s.ids["Send Tarun"], status: "done" } });
    expect(m.isError).toBeFalsy();
    const bad = await client.callTool({ name: "list_open", arguments: { kind: "nonsense" } });
    expect(bad.isError).toBe(true);
    await client.close();
  });
});
