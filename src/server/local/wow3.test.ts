import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore } from "@/server/store";
import { FileStore } from "./file-store";
import { freshSummary, notifyFreshMeetings } from "./fresh";

const now = new Date("2026-11-25T08:30:00.000Z");

async function setup(store: MemoryStore, startedAt: string, kinds: Array<"owe" | "waiting" | "decision">, processedAt = now.toISOString()) {
  const user = store.users.size ? [...store.users.values()][0] : store.addUser({ email: "you@this-mac", name: "Maruthi" });
  const { meeting } = await store.upsertMeeting({ userId: user.id, providerMeetingId: `p-${startedAt}`, title: "Design sync", startedAt, participants: [] });
  await store.commitExtraction({
    meetingId: meeting.id, userId: user.id, at: processedAt, closes: [],
    newItems: kinds.map((kind, k) => ({ kind, text: `Thing ${k}`, person: "Nitin", quote: "q", meetingId: meeting.id, dueAt: null })),
  });
  return { user, meeting };
}

describe("right after a meeting", () => {
  let dir: string | null = null;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });

  it("summarises what a meeting produced", () => {
    expect(freshSummary([{ kind: "owe" }, { kind: "owe" }, { kind: "waiting" }])).toBe("2 you owe, 1 waiting");
    expect(freshSummary([{ kind: "decision" }, { kind: "decision" }])).toBe("2 decisions");
    expect(freshSummary([])).toBeNull();
  });

  it("notifies once per new meeting with items", async () => {
    const store = new MemoryStore();
    await setup(store, "2026-11-25T07:30:00.000Z", ["owe", "owe", "waiting"]);
    const sent: Array<[string, string]> = [];
    const notify = (t: string, b: string) => { sent.push([t, b]); };
    expect(await notifyFreshMeetings(store, now, notify)).toBe(1);
    expect(sent[0][1]).toBe("From Design sync: 2 you owe, 1 waiting");
    expect(await notifyFreshMeetings(store, now, notify)).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it("skips backfill and re-reads (meetings older than 3 hours) and meetings with nothing in them", async () => {
    const store = new MemoryStore();
    await setup(store, "2026-11-25T04:00:00.000Z", ["owe"]); // 4.5 h ago
    await setup(store, "2026-11-25T08:00:00.000Z", []);
    const sent: string[] = [];
    expect(await notifyFreshMeetings(store, now, (_t, b) => sent.push(b))).toBe(0);
  });

  it("remembers what it sent across restarts (FileStore)", async () => {
    dir = mkdtempSync(join(tmpdir(), "db-wow3-"));
    const path = join(dir, "state.json");
    const a = new FileStore(path);
    await setup(a, "2026-11-25T07:00:00.000Z", ["decision"]);
    const sent: string[] = [];
    expect(await notifyFreshMeetings(a, now, (_t, b) => sent.push(b))).toBe(1);
    const b = new FileStore(path);
    expect(await notifyFreshMeetings(b, now, (_t, x) => sent.push(x))).toBe(0);
    expect(sent).toEqual(["From Design sync: 1 decision"]);
  });

  it("never throws", async () => {
    const broken = { listUsers: async () => { throw new Error("disk"); } } as unknown as MemoryStore;
    expect(await notifyFreshMeetings(broken, now, () => {})).toBe(0);
  });
});
