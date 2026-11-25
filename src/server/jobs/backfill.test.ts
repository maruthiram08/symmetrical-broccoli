import { describe, expect, it } from "vitest";
import { MemoryStore } from "@/server/store";
import { connect, FakeWispr, fakeDeps, meeting } from "@/server/testing";
import { backfillUser } from "./backfill";

describe("backfillUser", () => {
  it("polls 7 days, processes everything and reports the totals", async () => {
    const store = new MemoryStore();
    const wispr = new FakeWispr();
    const { deps } = fakeDeps({ store, wispr, now: new Date("2026-11-25T12:00:00.000Z") });
    const u = store.addUser({ email: "a@x.com" });
    connect(store, u.id);
    wispr.meetings.set(u.id, [meeting("m1", "2026-11-20T09:00:00.000Z"), meeting("m2", "2026-11-24T09:00:00.000Z"), meeting("old", "2026-11-10T09:00:00.000Z")]);
    wispr.transcripts.set("m1", "x: I'll do it");
    wispr.transcripts.set("m2", "y: I'll do that");
    expect(await backfillUser(deps, u.id)).toEqual({ meetings: 2, promisesMade: 2, stillOpen: 2, done: true });
    expect(store.events).toContainEqual(expect.objectContaining({ type: "backfill" }));
  });
});
