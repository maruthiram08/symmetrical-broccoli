import { describe, expect, it } from "vitest";
import { MemoryStore } from "@/server/store";
import { connect, FakeWispr, meeting } from "@/server/testing";
import { pollAll, pollUser } from "./poll";

const NOW = new Date("2026-11-25T12:00:00.000Z");

function setup() {
  const store = new MemoryStore();
  const wispr = new FakeWispr();
  const deps = { store, wispr: wispr.client, now: () => NOW };
  return { store, wispr, deps };
}

describe("pollUser", () => {
  it("is idempotent: the same meeting twice gives one row", async () => {
    const { store, wispr, deps } = setup();
    const u = store.addUser({ email: "a@x.com" });
    connect(store, u.id);
    wispr.meetings.set(u.id, [meeting("m1", "2026-11-25T09:00:00.000Z")]);
    expect(await pollUser(deps, u.id)).toMatchObject({ ok: true, found: 1, created: 1 });
    // lastSeenAt is inclusive, so the next poll sees m1 again.
    expect(await pollUser(deps, u.id)).toMatchObject({ ok: true, found: 1, created: 0 });
    expect([...store.meetings.values()].filter((m) => m.providerMeetingId === "m1")).toHaveLength(1);
  });

  it("backfills 7 days on the first run, then fetches from lastSeenAt", async () => {
    const { store, wispr, deps } = setup();
    const u = store.addUser({ email: "a@x.com" });
    connect(store, u.id);
    wispr.meetings.set(u.id, [
      meeting("old", "2026-11-17T12:00:00.000Z"), // 8 days ago: outside the window
      meeting("m1", "2026-11-18T12:00:00.000Z"),
      meeting("m2", "2026-11-24T08:00:00.000Z"),
    ]);
    await pollUser(deps, u.id);
    expect(wispr.sinceCalls[0].since).toBe("2026-11-18T12:00:00.000Z");
    expect([...store.meetings.values()].map((m) => m.providerMeetingId).sort()).toEqual(["m1", "m2"]);
    expect(store.connections.get(u.id)?.lastSeenAt).toBe("2026-11-24T08:00:00.000Z");
    await pollUser(deps, u.id);
    expect(wispr.sinceCalls[1].since).toBe("2026-11-24T08:00:00.000Z");
  });

  it("does not queue a meeting still being recorded, nor move past it", async () => {
    const { store, wispr, deps } = setup();
    const u = store.addUser({ email: "a@x.com" });
    connect(store, u.id, { lastSeenAt: "2026-11-25T08:00:00.000Z" });
    wispr.meetings.set(u.id, [
      meeting("live", "2026-11-25T10:00:00.000Z", { finalized: false }),
      meeting("later", "2026-11-25T11:00:00.000Z"),
    ]);
    await pollUser(deps, u.id);
    expect([...store.meetings.values()].map((m) => m.providerMeetingId)).toEqual(["later"]);
    expect(store.connections.get(u.id)?.lastSeenAt).toBe("2026-11-25T10:00:00.000Z");
  });

  it("skips users without an active connection", async () => {
    const { store, deps } = setup();
    const a = store.addUser({ email: "a@x.com" });
    const b = store.addUser({ email: "b@x.com" });
    connect(store, b.id, { status: "needs_reconnect" });
    expect(await pollUser(deps, a.id)).toMatchObject({ ok: true, skipped: "not_connected" });
    expect(await pollUser(deps, b.id)).toMatchObject({ ok: true, skipped: "needs_reconnect" });
  });
});

describe("pollAll", () => {
  it("one user's failure doesn't stop the others", async () => {
    const { store, wispr, deps } = setup();
    const bad = store.addUser({ email: "bad@x.com" });
    const good = store.addUser({ email: "good@x.com" });
    connect(store, bad.id);
    connect(store, good.id);
    wispr.failingUsers.add(bad.id);
    wispr.meetings.set(good.id, [meeting("g1", "2026-11-25T09:00:00.000Z")]);
    const results = await pollAll(deps);
    expect(results.find((r) => r.userId === bad.id)).toMatchObject({ ok: false });
    expect(results.find((r) => r.userId === good.id)).toMatchObject({ ok: true, created: 1 });
    expect(store.events).toContainEqual(expect.objectContaining({ userId: bad.id, type: "job_error", payload: expect.objectContaining({ job: "poll" }) }));
  });
});
