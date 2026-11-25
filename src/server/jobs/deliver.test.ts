import { describe, expect, it } from "vitest";
import { MemoryStore } from "@/server/store";
import { connect, FakeWispr, fakeDeps } from "@/server/testing";
import { deliverDue, isBriefDue, localClock } from "./deliver";

const at = (iso: string) => new Date(iso);

describe("isBriefDue", () => {
  const kolkata = { timeZone: "Asia/Kolkata", briefTime: "18:00" }; // 18:00 IST = 12:30Z
  const ny = { timeZone: "America/New_York", briefTime: "09:15" }; // 09:15 EST = 14:15Z in November
  it("Asia/Kolkata 18:00", () => {
    expect(isBriefDue(kolkata, at("2026-11-25T12:29:59Z"))).toBe(false);
    expect(isBriefDue(kolkata, at("2026-11-25T12:30:00Z"))).toBe(true);
    expect(isBriefDue(kolkata, at("2026-11-25T12:34:59Z"))).toBe(true);
    expect(isBriefDue(kolkata, at("2026-11-25T13:29:59Z"))).toBe(true); // a missed tick still sends
    expect(isBriefDue(kolkata, at("2026-11-25T13:30:00Z"))).toBe(false);
  });
  it("America/New_York 09:15, across DST", () => {
    expect(isBriefDue(ny, at("2026-11-25T14:15:00Z"))).toBe(true);
    expect(isBriefDue(ny, at("2026-11-25T13:15:00Z"))).toBe(false);
    expect(isBriefDue(ny, at("2026-07-15T13:17:00Z"))).toBe(true); // EDT
  });
  it("local date follows the user's zone", () => {
    expect(localClock(at("2026-11-25T20:00:00Z"), "Asia/Kolkata").date).toBe("2026-11-26");
    expect(localClock(at("2026-11-26T02:00:00Z"), "America/New_York").date).toBe("2026-11-25");
  });
});

function setup(now: Date) {
  const store = new MemoryStore();
  const wispr = new FakeWispr();
  const f = fakeDeps({ store, wispr, now });
  const india = store.addUser({ email: "in@x.com", timeZone: "Asia/Kolkata", briefTime: "18:00" });
  const us = store.addUser({ email: "us@x.com", timeZone: "America/New_York", briefTime: "09:15" });
  connect(store, india.id);
  connect(store, us.id);
  return { store, wispr, india, us, ...f };
}

describe("deliverDue", () => {
  it("sends each user at their own local time, once per day", async () => {
    const { deps, sent, store, india, us, setNow } = setup(at("2026-11-25T12:30:00Z"));
    await deliverDue(deps, at("2026-11-25T12:30:00Z"));
    expect(sent.map((s) => s.to)).toEqual(["in@x.com"]);
    expect(await store.getBrief(india.id, "2026-11-25")).toEqual({ sentAt: "2026-11-25T12:30:00.000Z" });
    expect(store.events).toContainEqual(expect.objectContaining({ userId: india.id, type: "brief_sent" }));

    // Next 5-minute tick still inside the window for a late cron: no second email.
    setNow(at("2026-11-25T12:33:00Z"));
    const again = await deliverDue(deps, at("2026-11-25T12:33:00Z"));
    expect(again.find((r) => r.userId === india.id)).toEqual({ userId: india.id, status: "already_sent" });
    expect(sent).toHaveLength(1);

    setNow(at("2026-11-25T14:15:00Z"));
    await deliverDue(deps, at("2026-11-25T14:15:00Z"));
    expect(sent.map((s) => s.to)).toEqual(["in@x.com", "us@x.com"]);
    expect(await store.getBrief(us.id, "2026-11-25")).not.toBeNull();
  });

  it("processes unprocessed meetings before building the brief", async () => {
    const { deps, store, wispr, india } = setup(at("2026-11-25T12:31:00Z"));
    const { meeting } = await store.upsertMeeting({ userId: india.id, providerMeetingId: "p1", title: "Sync", startedAt: "2026-11-25T09:00:00.000Z", participants: [] });
    wispr.transcripts.set("p1", "Maruthi: I'll do it.");
    let processedWhenBuilt: string | null = null;
    deps.buildBrief = async (s, u, now) => {
      processedWhenBuilt = (await s.getMeeting(meeting.id))!.processedAt;
      return (await import("@/server/testing")).emptyBrief(u, now.toISOString().slice(0, 10));
    };
    await deliverDue(deps, at("2026-11-25T12:31:00Z"));
    expect(processedWhenBuilt).not.toBeNull();
  });

  it("one user's failure doesn't stop the others", async () => {
    const { deps, store, sent } = setup(at("2026-11-25T12:30:00Z"));
    const other = store.addUser({ email: "in2@x.com", timeZone: "Asia/Kolkata", briefTime: "18:00" });
    const publish = deps.publish;
    deps.publish = async (u, m, md) => { if (u.email === "in@x.com") throw new Error("disk full"); return publish(u, m, md); };
    const results = await deliverDue(deps, at("2026-11-25T12:30:00Z"));
    expect(results.find((r) => r.status === "failed")).toBeDefined();
    expect(sent.map((s) => s.to)).toEqual(["in2@x.com"]);
    expect(await store.getBrief(other.id, "2026-11-25")).not.toBeNull();
    expect(store.events).toContainEqual(expect.objectContaining({ type: "job_error", payload: expect.objectContaining({ job: "deliver" }) }));
  });
});
