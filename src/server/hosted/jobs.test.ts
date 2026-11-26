import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { Connection, User } from "@/lib/types";
import type { MemoryStore } from "@/server/store";
import { FakeWispr, fakeDeps, meeting } from "@/server/testing";
import { withUserLock, type Db } from "./db";
import { cronDeliver, cronPoll, isCronAuthorized, summarize, type CronRuntime } from "./jobs";
import { HostedStore } from "./store";
import { memDb, TEST_KEY } from "./testing";

const NOW = new Date("2026-11-25T13:00:00.000Z"); // 18:30 in Kolkata
let db: Db, root: HostedStore, wispr: FakeWispr, users: User[];
let sent: Array<{ to: string }>;
let inFlight = 0, maxInFlight = 0;

const conn = (userId: string, lastSeenAt: string | null): Connection => ({
  userId, provider: "wispr_flow", accessToken: "a", refreshToken: "r", expiresAt: "2099-01-01T00:00:00.000Z", lastSeenAt, status: "active",
});

const by = <T extends { userId: string }>(runs: T[], id: string): T => runs.find((r) => r.userId === id)!;

function runtime(extra: Partial<CronRuntime> = {}): CronRuntime {
  return {
    root, concurrency: 2,
    depsFor: (id) => {
      const { deps } = fakeDeps({ store: root.forUser(id) as unknown as MemoryStore, wispr, now: NOW });
      const extract = deps.extract;
      deps.extract = async (input) => {
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return extract(input);
      };
      deps.publish = async (user) => { sent.push({ to: user.email }); return { id: `m-${user.id}` }; };
      return deps;
    },
    ...extra,
  };
}

beforeEach(async () => {
  db = memDb().db;
  root = new HostedStore(db, null, TEST_KEY);
  wispr = new FakeWispr();
  sent = [];
  inFlight = 0; maxInFlight = 0;
  users = [];
  for (let k = 0; k < 4; k++) {
    const id = randomUUID();
    await root.ensureUser(id, `u${k}@x.com`);
    users.push((await root.updateUser(id, { name: `U${k}`, briefTime: "18:00", timeZone: "Asia/Kolkata" }))!);
    await root.saveConnection(conn(id, "2026-11-24T00:00:00.000Z"));
    wispr.meetings.set(id, [meeting(`p${k}a`, "2026-11-25T09:00:00.000Z"), meeting(`p${k}b`, "2026-11-25T10:00:00.000Z")]);
    wispr.transcripts.set(`p${k}a`, "x"); wispr.transcripts.set(`p${k}b`, "y");
  }
  await db.query("update users set created_at = $1", ["2026-11-01T00:00:00.000Z"]);
});

describe("cronPoll", () => {
  it("polls and reads every user, a few at a time", async () => {
    const runs = await cronPoll(runtime(), { deadline: Date.now() + 60_000 });
    expect(runs.map((r) => r.status)).toEqual(["ok", "ok", "ok", "ok"]);
    expect(runs[0]).toMatchObject({ created: 2, processed: 2 });
    expect(maxInFlight).toBeLessThanOrEqual(2);
    for (const u of users) expect(await root.listItems(u.id)).toHaveLength(2);
  });

  it("skips a user whose lock another run holds", async () => {
    let runs: Awaited<ReturnType<typeof cronPoll>> = [];
    await withUserLock(db, users[0].id, async () => { runs = await cronPoll(runtime(), { deadline: Date.now() + 60_000 }); });
    expect(by(runs, users[0].id).status).toBe("locked");
    expect(runs.filter((r) => r.status === "ok")).toHaveLength(3);
    expect(await root.listItems(users[0].id)).toHaveLength(0);
  });

  it("leaves users alone until their first read has started, and respects the free tier", async () => {
    await root.saveConnection(conn(users[1].id, null));
    const rt = runtime();
    const depsFor = rt.depsFor;
    rt.depsFor = (id) => ({ ...depsFor(id), allowance: async () => (id === users[2].id ? 1 : Infinity) });
    const runs = await cronPoll(rt, { deadline: Date.now() + 60_000 });
    expect(by(runs, users[1].id).status).toBe("waiting_first_read");
    expect(by(runs, users[2].id)).toMatchObject({ status: "ok", processed: 1, remaining: 1 });
  });

  it("one user's failure doesn't stop the others", async () => {
    wispr.failingUsers.add(users[0].id);
    const runs = await cronPoll(runtime(), { deadline: Date.now() + 60_000 });
    expect(by(runs, users[0].id).status).toBe("failed");
    expect(summarize(runs)).toEqual({ users: 4, failed: 1, ok: 3 });
  });
});

describe("cronDeliver", () => {
  it("sends each due brief once and runs nudges after", async () => {
    await root.updateUser(users[3].id, { briefTime: "21:00" });
    const ai: string[] = [];
    const rt = runtime({ ai: async (u, o) => { ai.push(`${u.email}:${o.nudges}`); } });
    const first = await cronDeliver(rt, NOW);
    expect(users.map((u) => by(first, u.id).status)).toEqual(["sent", "sent", "sent", "not_due"]);
    expect(sent).toHaveLength(3);
    expect(ai).toEqual(expect.arrayContaining(["u0@x.com:true"]));
    const again = await cronDeliver(rt, new Date(NOW.getTime() + 15 * 60_000));
    expect(users.map((u) => by(again, u.id).status)).toEqual(["already_sent", "already_sent", "already_sent", "not_due"]);
    expect(sent).toHaveLength(3);
  });
});

describe("isCronAuthorized", () => {
  const req = (h?: string) => new Request("https://x/api/cron/poll", { headers: h ? { authorization: h } : {} });
  it("needs the exact bearer secret", () => {
    expect(isCronAuthorized(req("Bearer s3cret-s3cret-s3cret-123"), "s3cret-s3cret-s3cret-123")).toBe(true);
    expect(isCronAuthorized(req("Bearer nope"), "s3cret-s3cret-s3cret-123")).toBe(false);
    expect(isCronAuthorized(req(), "s3cret-s3cret-s3cret-123")).toBe(false);
    expect(isCronAuthorized(req("Bearer "), "")).toBe(false);
  });
});
