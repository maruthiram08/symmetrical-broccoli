import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryStore } from "@/server/store";
import { connect, FakeWispr, fakeDeps, meeting } from "@/server/testing";
import { FileStore } from "./file-store";
import { alertsFor, readingBlocked, summarizeHealth, WISPR_UNREACHABLE_MS } from "./health";
import { SchedulerLock } from "./lock";
import { errLine, redact, rotateLog } from "./log";
import { newTickState, POLL_RETRY_MS, runTick, TICK_MS } from "./scheduler";

const tmp = () => mkdtempSync(join(tmpdir(), "db-robust-"));

async function seeded(path: string) {
  const s = new FileStore(path);
  const u = s.addUser({ email: "you@this-mac", name: "Maruthi" });
  await s.upsertMeeting({ userId: u.id, providerMeetingId: "p1", title: "Standup", startedAt: "2026-11-25T05:30:00Z", participants: [] });
  return { s, u };
}

describe("FileStore: damaged or missing state.json", () => {
  it("writes a rolling backup, and restores it when state.json is cut off mid-write", async () => {
    const dir = tmp();
    const path = join(dir, "state.json");
    const { u } = await seeded(path);
    expect(existsSync(`${path}.bak`)).toBe(true);
    expect(existsSync(`${path}.bak-daily`)).toBe(true);
    expect(statSync(`${path}.bak`).mode & 0o777).toBe(0o600);

    const good = readFileSync(path, "utf8");
    writeFileSync(path, good.slice(0, Math.floor(good.length / 2))); // partial write

    const b = new FileStore(path);
    expect((await b.getUser(u.id))?.name).toBe("Maruthi");
    // The backup is up to an hour old: the meeting queued after it is gone, and the next poll
    // (lastSeenAt went back with it) queues it again.
    expect(await b.listUnprocessedMeetings(u.id)).toHaveLength(0);
    const rec = await b.getRecovery();
    expect(rec).toMatchObject({ from: "state.json.bak" });
    // The damaged file is kept, byte for byte.
    const kept = readdirSync(dir).filter((f) => f.startsWith("state.json.corrupt-"));
    expect(kept).toHaveLength(1);
    expect(rec?.corruptFile).toBe(kept[0]);
    expect(readFileSync(join(dir, kept[0]), "utf8")).toBe(good.slice(0, Math.floor(good.length / 2)));
    // state.json is whole again, and the notice survives a restart until dismissed.
    expect(JSON.parse(readFileSync(path, "utf8")).users).toHaveLength(1);
    expect(await new FileStore(path).getRecovery()).toMatchObject({ from: "state.json.bak" });
    await b.dismissRecovery();
    expect(await new FileStore(path).getRecovery()).toBeNull();
  });

  it("falls back to the daily backup when the hourly one is damaged too", async () => {
    const path = join(tmp(), "state.json");
    const { u } = await seeded(path);
    writeFileSync(`${path}.bak`, "{");
    writeFileSync(path, "");
    const b = new FileStore(path);
    expect(await b.getUser(u.id)).not.toBeNull();
    expect(b.recovery?.from).toBe("state.json.bak-daily");
  });

  it("valid JSON that isn't a state (e.g. null) counts as damaged", async () => {
    const path = join(tmp(), "state.json");
    const { u } = await seeded(path);
    writeFileSync(path, "null");
    expect(await new FileStore(path).getUser(u.id)).not.toBeNull();
  });

  it("with no backup, keeps the bad file, starts empty and says so; old backups aren't overwritten", async () => {
    const dir = tmp();
    const path = join(dir, "state.json");
    writeFileSync(path, "{\"users\": [");
    const b = new FileStore(path);
    expect(await b.listUsers()).toEqual([]);
    expect(b.recovery).toMatchObject({ from: null });
    expect(readdirSync(dir).some((f) => f.startsWith("state.json.corrupt-"))).toBe(true);
    b.addUser({ email: "x" });
    expect(existsSync(`${path}.bak`)).toBe(false); // nothing written over until the user dismisses
  });

  it("restores a deleted state.json from its backup instead of starting empty", async () => {
    const path = join(tmp(), "state.json");
    const { u } = await seeded(path);
    unlinkSync(path);
    const b = new FileStore(path);
    expect(await b.getUser(u.id)).not.toBeNull();
    expect(b.recovery).toMatchObject({ from: "state.json.bak", corruptFile: null });
  });

  it("refreshes the hourly backup only once it is an hour old", async () => {
    const path = join(tmp(), "state.json");
    const { s, u } = await seeded(path);
    await s.updateUser(u.id, { name: "Second" });
    expect(JSON.parse(readFileSync(`${path}.bak`, "utf8")).users[0].name).toBe("Maruthi");
    const old = new Date(Date.now() - 61 * 60_000);
    utimesSync(`${path}.bak`, old, old);
    await s.updateUser(u.id, { name: "Third" });
    expect(JSON.parse(readFileSync(`${path}.bak`, "utf8")).users[0].name).toBe("Third");
    expect(JSON.parse(readFileSync(`${path}.bak-daily`, "utf8")).users[0].name).toBe("Maruthi");
  });

  it("keeps health and meeting failures across restarts", async () => {
    const path = join(tmp(), "state.json");
    const { s, u } = await seeded(path);
    const [m] = await s.listUnprocessedMeetings(u.id);
    await s.recordMeetingFailure(m.id, "transient", "2026-11-25T06:00:00.000Z");
    await s.setHealth({ lastPollOkAt: "2026-11-25T06:00:00.000Z" });
    const b = new FileStore(path);
    expect((await b.getMeeting(m.id))?.failedAttempts).toBe(1);
    expect((await b.getHealth()).lastPollOkAt).toBe("2026-11-25T06:00:00.000Z");
  });
});

describe("SchedulerLock", () => {
  it("lets one process run the jobs and hands over when it dies or stops beating", () => {
    const path = join(tmp(), "scheduler.lock");
    let clock = Date.parse("2026-11-25T10:00:00Z");
    const alive = new Set([100, 200]);
    const mk = (pid: number) => new SchedulerLock(path, { pid, now: () => clock, isAlive: (p) => alive.has(p) });
    const app = mk(100);
    const agent = mk(200);
    expect(app.tryAcquire()).toBe(true);
    expect(agent.tryAcquire()).toBe(false);
    expect(agent.holder()?.pid).toBe(100);

    clock += 5 * 60_000;
    expect(app.tryAcquire()).toBe(true); // heartbeat
    expect(agent.tryAcquire()).toBe(false);

    // The app crashed without cleaning up: the pid is gone, so the agent takes over.
    alive.delete(100);
    expect(agent.tryAcquire()).toBe(true);
    alive.add(100); // ...or a different process got pid 100 later: still not the holder
    expect(app.tryAcquire()).toBe(false);

    // The holder hangs (no heartbeat for over 10 minutes): another may take over, and the old
    // holder steps down on its next check.
    clock += 11 * 60_000;
    expect(app.tryAcquire()).toBe(true);
    expect(agent.tryAcquire()).toBe(false);

    app.release();
    expect(existsSync(path)).toBe(false);
    expect(agent.tryAcquire()).toBe(true);
    app.release(); // not the holder: leaves it alone
    expect(agent.holder()?.pid).toBe(200);
  });

  it("treats an unreadable lock file as stale", () => {
    const path = join(tmp(), "scheduler.lock");
    writeFileSync(path, "garbage");
    expect(new SchedulerLock(path, { pid: 1 }).tryAcquire()).toBe(true);
  });
});

describe("log", () => {
  it("rotates by copy-and-truncate, keeping three old files", () => {
    const p = join(tmp(), "daily-brief.log");
    for (let i = 1; i <= 5; i++) {
      writeFileSync(p, `run ${i} `.repeat(50));
      expect(rotateLog(p, 100, 3)).toBe(true);
      expect(statSync(p).size).toBe(0);
    }
    expect(readFileSync(`${p}.1`, "utf8")).toContain("run 5");
    expect(readFileSync(`${p}.3`, "utf8")).toContain("run 3");
    expect(existsSync(`${p}.4`)).toBe(false);
    writeFileSync(p, "small");
    expect(rotateLog(p, 100, 3)).toBe(false);
    expect(rotateLog(join(tmp(), "missing.log"))).toBe(false);
  });

  it("never lets keys or tokens into a log line", () => {
    const line = errLine(new Error("401 x-api-key: sk-ant-api03-AbCdEf123456789 Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk refresh_token=rt-secret-value https://x/cb?code=abc123&state=s"));
    expect(line).not.toMatch(/sk-ant-api03|rt-secret-value|abc123|eyJhbGci/);
    expect(line).toContain("[redacted]");
    expect(redact("error code: 529 overloaded")).toBe("error code: 529 overloaded");
    expect(errLine(new Error("x\n".repeat(500))).length).toBeLessThan(260);
  });
});

describe("runTick: sleep, wake and offline", () => {
  const KOLKATA_6PM = Date.parse("2026-11-25T12:30:00Z");

  function setup(nowMs: number) {
    const store = new MemoryStore();
    const wispr = new FakeWispr();
    const f = fakeDeps({ store, wispr, now: new Date(nowMs) });
    const user = store.addUser({ email: "in@x.com", name: "Maruthi", timeZone: "Asia/Kolkata", briefTime: "18:00", createdAt: "2026-11-20T00:00:00.000Z" });
    connect(store, user.id, { lastSeenAt: "2026-11-24T12:00:00.000Z" }); // past the first read
    return { store, wispr, user, ...f };
  }

  it("a Mac asleep through brief time delivers once on waking, never twice", async () => {
    const wake = KOLKATA_6PM + 150 * 60_000; // 20:30 IST
    const { deps, sent, setNow, wispr, user } = setup(wake);
    wispr.meetings.set(user.id, [meeting("m1", "2026-11-25T09:00:00.000Z")]);
    const st = newTickState();
    st.lastTickAt = KOLKATA_6PM - 3 * 60 * 60_000; // last tick before the lid closed
    st.lastPoll = st.lastTickAt;

    const first = await runTick(deps, st, { nowMs: wake });
    expect(first.polled).toBe(true); // catches up on meetings first
    expect(sent).toHaveLength(1);
    expect(first.delivered[0]).toMatchObject({ status: "sent" });

    for (let i = 1; i <= 3; i++) {
      setNow(new Date(wake + i * TICK_MS));
      await runTick(deps, st, { nowMs: wake + i * TICK_MS });
    }
    expect(sent).toHaveLength(1);
  });

  it("waking without network: retries the poll in 5 minutes and holds the brief for a working poll", async () => {
    const wake = KOLKATA_6PM + 60 * 60_000;
    const { deps, sent, setNow, wispr, user } = setup(wake);
    wispr.failingUsers.add(user.id);
    const st = newTickState();
    await runTick(deps, st, { nowMs: wake });
    expect(sent).toHaveLength(0);
    expect(wispr.sinceCalls).toHaveLength(1);

    // Next tick inside the retry window: polls again (not 30 minutes later).
    setNow(new Date(wake + POLL_RETRY_MS));
    await runTick(deps, st, { nowMs: wake + POLL_RETRY_MS });
    expect(wispr.sinceCalls).toHaveLength(2);
    expect(sent).toHaveLength(0);

    // Wi-Fi is back.
    wispr.failingUsers.delete(user.id);
    setNow(new Date(wake + 2 * POLL_RETRY_MS));
    await runTick(deps, st, { nowMs: wake + 2 * POLL_RETRY_MS });
    expect(sent).toHaveLength(1);
  });

  it("still delivers when Wispr Flow stays unreachable for 30 minutes", async () => {
    const wake = KOLKATA_6PM + 60 * 60_000;
    const { deps, sent, setNow, wispr, user } = setup(wake);
    wispr.failingUsers.add(user.id);
    const st = newTickState();
    for (let t = wake; t <= wake + 35 * 60_000; t += TICK_MS) {
      setNow(new Date(t));
      await runTick(deps, st, { nowMs: t });
    }
    expect(sent).toHaveLength(1);
  });

  it("no surprise brief right after setting up after brief time", async () => {
    const now = KOLKATA_6PM + 60 * 60_000;
    const { deps, sent, store, user } = setup(now);
    store.users.get(user.id)!.createdAt = new Date(now - 10 * 60_000).toISOString();
    await runTick(deps, newTickState(), { nowMs: now });
    expect(sent).toHaveLength(0);
  });
});

describe("alerts and health", () => {
  const now = new Date("2026-11-25T12:00:00.000Z");
  const conn = { userId: "u", provider: "wispr_flow" as const, accessToken: "a", refreshToken: "r", expiresAt: "", lastSeenAt: null, status: "active" as const };

  it("asks to reconnect Wispr Flow, names the Anthropic problem and counts set-aside meetings", () => {
    const a = alertsFor({
      conn: { ...conn, status: "needs_reconnect" },
      health: { anthropicProblem: { kind: "credit", at: now.toISOString() } },
      recovery: null,
      meetings: [{ processedAt: null, failedAttempts: 9 }, { processedAt: null, failedAttempts: 1 }, { processedAt: "x", failedAttempts: 0 }],
      now,
    });
    expect(a.map((x) => x.kind)).toEqual(["wispr_reconnect", "anthropic_credit", "meetings_failed"]);
    expect(a[2]).toEqual({ kind: "meetings_failed", count: 1 });
    expect(readingBlocked(a)).toBe(true);
    expect(alertsFor({ conn, health: {}, recovery: null, meetings: [], now })).toEqual([]);
  });

  it("says Wispr Flow can't be reached only after two hours of failed polls", () => {
    const okAt = (ms: number) => new Date(now.getTime() - ms).toISOString();
    const errAt = now.toISOString();
    expect(alertsFor({ conn, health: { lastPollOkAt: okAt(30 * 60_000), lastPollErrorAt: errAt }, recovery: null, meetings: [], now })).toEqual([]);
    expect(alertsFor({ conn, health: { lastPollOkAt: okAt(WISPR_UNREACHABLE_MS + 1), lastPollErrorAt: errAt }, recovery: null, meetings: [], now })[0]).toMatchObject({ kind: "wispr_unreachable" });
  });

  it("summarises the last day for Settings", () => {
    const path = join(tmp(), "state.json");
    writeFileSync(path, "x".repeat(2048));
    const h = summarizeHealth({
      health: { lastPollOkAt: "2026-11-25T11:30:00.000Z", lastBriefAt: null },
      events: [
        { type: "job_error", at: "2026-11-25T11:00:00.000Z", payload: { job: "poll" } },
        { type: "job_error", at: "2026-11-25T10:00:00.000Z", payload: { job: "poll" } },
        { type: "job_error", at: "2026-11-25T09:00:00.000Z", payload: { job: "process" } },
        { type: "job_error", at: "2026-11-23T09:00:00.000Z", payload: { job: "old" } },
        { type: "extract_run", at: "2026-11-25T11:31:00.000Z" },
        { type: "brief_sent", at: "2026-11-24T12:30:00.000Z" },
      ],
      statePath: path,
      now,
      version: "0.1.0 (abc1234)",
    });
    expect(h).toMatchObject({
      lastPollOkAt: "2026-11-25T11:30:00.000Z",
      lastExtractOkAt: "2026-11-25T11:31:00.000Z",
      lastBriefAt: "2026-11-24T12:30:00.000Z",
      errors24h: 3,
      errorsByJob: [["poll", 2], ["process", 1]],
      lastErrorAt: "2026-11-25T11:00:00.000Z",
      dataBytes: 2048,
      version: "0.1.0 (abc1234)",
    });
  });
});
