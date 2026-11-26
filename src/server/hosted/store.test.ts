import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { Connection } from "@/lib/types";
import { pollUser } from "@/server/jobs/poll";
import { processPending } from "@/server/jobs/process";
import type { MemoryStore } from "@/server/store";
import { FakeWispr, fakeDeps, meeting } from "@/server/testing";
import { withUserLock, type Db } from "./db";
import { HostedStore, WrongUserError } from "./store";
import { memDb, TEST_KEY } from "./testing";

const AT = "2026-11-25T12:00:00.000Z";
let db: Db;
let root: HostedStore;
let a: string, b: string;

beforeEach(async () => {
  db = memDb().db;
  root = new HostedStore(db, null, TEST_KEY);
  a = randomUUID(); b = randomUUID();
  await root.ensureUser(a, "A@x.com");
  await root.ensureUser(b, "b@x.com");
});

const conn = (userId: string, extra: Partial<Connection> = {}): Connection => ({
  userId, provider: "wispr_flow", accessToken: "secret-access", refreshToken: "secret-refresh", expiresAt: "2099-01-01T00:00:00.000Z", lastSeenAt: null, status: "active", ...extra,
});

describe("HostedStore: users and connections", () => {
  it("creates users on first sign-in, once, with a referral code", async () => {
    await root.ensureUser(a, "a@x.com");
    const users = await root.listUsers();
    expect(users.map((u) => u.email).sort()).toEqual(["a@x.com", "b@x.com"]);
    const r = await db.query("select referral_code from users where id = $1", [a]);
    expect(r.rows[0].referral_code).toMatch(/^[0-9A-F]{8}$/);
  });

  it("updates settings", async () => {
    const u = await root.updateUser(a, { name: "Asha", aliases: ["Ash"], timeZone: "Europe/London", briefTime: "17:30", includeShared: true });
    expect(u).toMatchObject({ name: "Asha", aliases: ["Ash"], timeZone: "Europe/London", briefTime: "17:30", includeShared: true });
  });

  it("encrypts Wispr tokens and the client registration at rest", async () => {
    await root.saveConnection(conn(a));
    await root.saveOAuthClient(a, { client_id: "cid", client_secret: "csecret" });
    const raw = JSON.stringify((await db.query("select * from connections")).rows) + JSON.stringify((await db.query("select * from oauth_clients")).rows);
    expect(raw).not.toContain("secret-access");
    expect(raw).not.toContain("csecret");
    expect(await root.getConnection(a)).toMatchObject({ accessToken: "secret-access", refreshToken: "secret-refresh", status: "active", refreshFailures: 0 });
    expect(await root.getOAuthClient(a)).toEqual({ client_id: "cid", client_secret: "csecret" });
    await root.saveConnection(conn(a, { lastSeenAt: AT, status: "needs_reconnect", refreshFailures: 2 }));
    expect(await root.getConnection(a)).toMatchObject({ lastSeenAt: AT, status: "needs_reconnect", refreshFailures: 2 });
  });

  it("keeps the Slack webhook encrypted", async () => {
    await root.setDelivery(a, { email: false, slackWebhook: "https://hooks.slack.com/services/T/B/xyz" });
    expect(JSON.stringify((await db.query("select slack_webhook from users where id = $1", [a])).rows)).not.toContain("hooks.slack.com");
    expect(await root.getDelivery(a)).toEqual({ email: false, slackWebhook: "https://hooks.slack.com/services/T/B/xyz" });
  });
});

describe("HostedStore: scoping", () => {
  it("a scoped store refuses another user's ids and hides their rows", async () => {
    const sa = root.forUser(a);
    const { meeting: mb } = await root.upsertMeeting({ userId: b, providerMeetingId: "p", title: "B's", startedAt: AT, participants: [] });
    const item = await root.addManualItem(b, { kind: "owe", text: "B's thing", person: null, dueAt: null }, AT);
    await expect(sa.listItems(b)).rejects.toBeInstanceOf(WrongUserError);
    await expect(sa.getUser(b)).rejects.toBeInstanceOf(WrongUserError);
    expect(() => sa.forUser(b)).toThrow(WrongUserError);
    expect(await sa.getMeeting(mb.id)).toBeNull();
    expect(await sa.getItem(item.id)).toBeNull();
    expect(await sa.deleteItem(item.id)).toBe(false);
    await sa.setItemStatus(item.id, "done", AT);
    expect((await root.getItem(item.id))?.status).toBe("open");
    expect(await sa.updateItem(item.id, { text: "hacked" })).toBeNull();
    expect((await sa.listUsers()).map((u) => u.id)).toEqual([a]);
    expect(await sa.markPrepNotified(`${b}:x`).catch((e) => e)).toBeInstanceOf(WrongUserError);
  });

  it("ignores ids that are not uuids (URLs and forms)", async () => {
    expect(await root.getMeeting("manual")).toBeNull();
    expect(await root.getItem("../etc")).toBeNull();
    expect(await root.getUser("x")).toBeNull();
  });
});

describe("HostedStore: meetings and extraction", () => {
  it("upserts meetings once per provider id and lists them with open bounds", async () => {
    const one = await root.upsertMeeting({ userId: a, providerMeetingId: "p1", title: "Sync", startedAt: AT, participants: ["Nitin"], link: "https://x", shared: true, ownerName: "Ravi" });
    const two = await root.upsertMeeting({ userId: a, providerMeetingId: "p1", title: "Sync", startedAt: AT, participants: ["Nitin"] });
    expect(one.created).toBe(true);
    expect(two).toMatchObject({ created: false, meeting: { id: one.meeting.id, shared: true, ownerName: "Ravi", link: "https://x" } });
    expect(await root.listMeetingsBetween(a, "0000", "9999")).toHaveLength(1);
    expect(await root.listMeetingsBetween(a, "2026-11-26", "9999")).toHaveLength(0);
    expect(await root.listUnprocessedMeetings(a)).toHaveLength(1);
  });

  it("commits once, closes only the user's open items, and resets failures", async () => {
    const { meeting: m1 } = await root.upsertMeeting({ userId: a, providerMeetingId: "p1", title: "One", startedAt: AT, participants: [] });
    const { meeting: m2 } = await root.upsertMeeting({ userId: a, providerMeetingId: "p2", title: "Two", startedAt: "2026-11-25T13:00:00.000Z", participants: [] });
    const other = await root.addManualItem(b, { kind: "owe", text: "B", person: null, dueAt: null }, AT);
    await root.recordMeetingFailure(m1.id, "extract", AT);
    expect((await root.getMeeting(m1.id))?.failedAttempts).toBe(1);
    await root.commitExtraction({ meetingId: m1.id, userId: a, at: AT, closes: [], newItems: [{ kind: "owe", text: "Send deck", person: "Nitin", quote: "I'll send it", meetingId: m1.id, dueAt: null }] });
    await root.commitExtraction({ meetingId: m1.id, userId: a, at: AT, closes: [], newItems: [{ kind: "owe", text: "dup", person: null, quote: "", meetingId: m1.id, dueAt: null }] });
    const items = await root.listItems(a);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ text: "Send deck", source: "extracted", status: "open" });
    expect(await root.getMeeting(m1.id)).toMatchObject({ processedAt: AT, failedAttempts: 0, lastFailure: null });
    await root.commitExtraction({ meetingId: m2.id, userId: a, at: "2026-11-25T14:00:00.000Z", newItems: [], closes: [{ itemId: items[0].id, quote: "Sent it" }, { itemId: other.id, quote: "x" }, { itemId: "made-up", quote: "x" }] });
    expect(await root.getItem(items[0].id)).toMatchObject({ status: "done", closeQuote: "Sent it", closedByMeetingId: m2.id });
    expect((await root.getItem(other.id))?.status).toBe("open");
  });

  it("re-reading keeps hand-made marks and manual items", async () => {
    const { meeting: m } = await root.upsertMeeting({ userId: a, providerMeetingId: "p1", title: "One", startedAt: AT, participants: [] });
    await root.commitExtraction({ meetingId: m.id, userId: a, at: AT, closes: [], newItems: [
      { kind: "owe", text: "Send Nitin the final banner text", person: "Nitin", quote: "I'll send the banner text", meetingId: m.id, dueAt: null },
      { kind: "waiting", text: "Asha shares the logo", person: "Asha", quote: "I'll share the logo", meetingId: m.id, dueAt: null },
    ] });
    const [owe, wait] = await root.listItems(a);
    await root.setItemStatus(owe.id, "wrong", AT);
    await root.updateItem(wait.id, { starred: true });
    await root.addManualItem(a, { kind: "owe", text: "Mine", person: null, dueAt: null }, AT);
    expect(await root.resetExtraction(a)).toBe(1);
    expect((await root.listItems(a)).map((i) => i.text)).toEqual(["Mine"]);
    const later = "2026-11-26T09:00:00.000Z";
    await root.commitExtraction({ meetingId: m.id, userId: a, at: later, closes: [], newItems: [
      { kind: "owe", text: "Send Nitin the final banner text", person: "Nitin", quote: "I'll send the banner text", meetingId: m.id, dueAt: null },
      { kind: "waiting", text: "Asha shares the logo", person: "Asha", quote: "I'll share the logo", meetingId: m.id, dueAt: null },
    ] });
    const again = await root.listItems(a);
    expect(again.find((i) => i.kind === "owe" && i.source === "extracted")?.status).toBe("wrong");
    expect(again.find((i) => i.kind === "waiting")?.starred).toBe(true);
    expect((await db.query("select count(*)::int as n from marks")).rows[0].n).toBe(0);
  });

  it("counts meetings read since a date (free tier)", async () => {
    const { meeting: m } = await root.upsertMeeting({ userId: a, providerMeetingId: "p1", title: "One", startedAt: AT, participants: [] });
    await root.commitExtraction({ meetingId: m.id, userId: a, at: AT, closes: [], newItems: [] });
    expect(await root.countProcessedSince(a, "2026-11-01T00:00:00.000Z")).toBe(1);
    expect(await root.countProcessedSince(a, "2026-12-01T00:00:00.000Z")).toBe(0);
  });
});

describe("HostedStore: items, briefs, events and small state", () => {
  it("manual items: add, edit, due, delete", async () => {
    const i = await root.addManualItem(a, { kind: "waiting", text: " Get logo ", person: "Asha", dueAt: null, note: "n" }, AT);
    expect(i).toMatchObject({ text: "Get logo", source: "manual", meetingId: "manual" });
    expect(await root.updateItem(i.id, { text: "Get the logo", snoozedUntil: "2026-12-01" })).toMatchObject({ text: "Get the logo", snoozedUntil: "2026-12-01" });
    expect(await root.setItemDue(a, i.id, "2026-11-30T10:00:00.000Z")).toBe(true);
    expect((await root.getItem(i.id))?.dueAt).toBe("2026-11-30T10:00:00.000Z");
    expect(await root.deleteItem(i.id)).toBe(true);
    expect(await root.listItems(a)).toEqual([]);
  });

  it("briefs, events, looks, caches, prep keys, health and AI state", async () => {
    const sa = root.forUser(a), sb = root.forUser(b);
    await sa.saveBrief(a, "2026-11-25", "# hi", null, null);
    await sa.saveBrief(a, "2026-11-25", "# hi again", AT, "em1");
    expect(await sa.getBrief(a, "2026-11-25")).toEqual({ sentAt: AT });
    expect(await sa.listBriefs(a)).toEqual([{ date: "2026-11-25", markdown: "# hi again" }]);
    await sa.logEvent({ userId: a, type: "extract_run", tokensIn: 10, tokensOut: 2, costInr: 1.5, payload: { m: 1 } });
    await sb.logEvent({ userId: b, type: "extract_run" });
    expect(await sa.listEvents("extract_run")).toEqual([expect.objectContaining({ userId: a, type: "extract_run", tokensIn: 10, costInr: 1.5, payload: { m: 1 }, at: expect.any(String) })]);
    await sa.saveLastLook(a, { lastLookedAt: AT, since: null });
    expect(await sa.getLastLook(a)).toEqual({ lastLookedAt: AT, since: null });
    await sa.saveUpcoming(a, { fetchedAt: AT, meetings: [] });
    expect(await sa.getUpcoming(a)).toEqual({ fetchedAt: AT, meetings: [] });
    expect(await sa.getCalendar(a)).toBeNull();
    expect(await sa.markPrepNotified(`${a}:cal:1`)).toBe(true);
    expect(await sa.markPrepNotified(`${a}:cal:1`)).toBe(false);
    await sa.setHealth({ lastPollOkAt: AT });
    await sa.setHealth({ lastBriefAt: AT });
    expect(await sa.getHealth()).toEqual({ lastPollOkAt: AT, lastBriefAt: AT });
    expect(await sb.getHealth()).toEqual({});
    await sa.saveAiState(a, { nudges: [{ itemId: "x" }] });
    expect(await sa.getAiState(a)).toEqual({ nudges: [{ itemId: "x" }] });
    expect(await sa.getRecovery()).toBeNull();
  });

  it("deleting a user removes everything of theirs", async () => {
    await root.saveConnection(conn(a));
    await root.addManualItem(a, { kind: "owe", text: "x", person: null, dueAt: null }, AT);
    await root.upsertMeeting({ userId: a, providerMeetingId: "p", title: "t", startedAt: AT, participants: [] });
    await root.deleteUser(a);
    expect(await root.getConnection(a)).toBeNull();
    expect((await db.query("select count(*)::int as n from items")).rows[0].n).toBe(0);
    expect((await db.query("select count(*)::int as n from meetings")).rows[0].n).toBe(0);
    expect((await root.listUsers()).map((u) => u.id)).toEqual([b]);
  });
});

describe("the shared jobs run on HostedStore", () => {
  it("poll and process a user's meetings", async () => {
    const store = root.forUser(a);
    await store.saveConnection(conn(a));
    const wispr = new FakeWispr();
    wispr.meetings.set(a, [meeting("p1", "2026-11-25T09:00:00.000Z")]);
    wispr.transcripts.set("p1", "Maruthi: I'll send it.");
    const { deps } = fakeDeps({ store: store as unknown as MemoryStore, wispr, now: new Date(AT) });
    expect(await pollUser(deps, a)).toMatchObject({ ok: true, created: 1 });
    expect(await processPending(deps, a)).toMatchObject({ processed: 1, failed: 0 });
    expect(await store.listItems(a)).toEqual([expect.objectContaining({ text: "Send Nitin the banner text" })]);
    expect((await store.getConnection(a))?.lastSeenAt).toBe("2026-11-25T09:00:00.000Z");
    expect((await store.getHealth()).lastPollOkAt).toBe(AT);
  });
});

describe("withUserLock", () => {
  it("lets one run per user through and releases after", async () => {
    let inner: unknown;
    const outer = await withUserLock(db, a, async () => {
      inner = await withUserLock(db, a, async () => "second");
      const other = await withUserLock(db, b, async () => "b runs");
      return other;
    });
    expect(inner).toEqual({ locked: false });
    expect(outer).toEqual({ locked: true, value: { locked: true, value: "b runs" } });
    expect(await withUserLock(db, a, async () => 1)).toEqual({ locked: true, value: 1 });
  });

  it("releases the lock when the job throws", async () => {
    await expect(withUserLock(db, a, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await withUserLock(db, a, async () => 2)).toEqual({ locked: true, value: 2 });
  });
});
