import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { fakeCreate, toolCall } from "@/lib/ai/fakes.test-helpers";
import type { User } from "@/lib/types";
import { AiStore } from "./ai-store";
import { runAiJobs, runContradictions, runNudges, type AiDeps } from "./ai-jobs";
import { FileStore } from "./file-store";

// Wed 25 Nov 2026, 6:30 PM in Kolkata (brief at 18:00).
const NOW = new Date("2026-11-25T13:00:00Z");

let store: FileStore, ai: AiStore, user: User, dir: string;
const ids: Record<string, string> = {};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "db-ai-"));
  store = new FileStore(join(dir, "state.json"));
  ai = new AiStore(join(dir, "ai.json"));
  user = store.addUser({ email: "you@this-mac", name: "Maruthi", timeZone: "Asia/Kolkata" });
  const m1 = (await store.upsertMeeting({ userId: user.id, providerMeetingId: "1", title: "Dividend sync", startedAt: "2026-11-18T06:00:00Z", participants: ["Nitin K"] })).meeting;
  await store.commitExtraction({ meetingId: m1.id, userId: user.id, at: "2026-11-18T07:00:00Z", closes: [], newItems: [
    { kind: "waiting", text: "Nitin to share the payout calendar", person: "Nitin K", quote: "I'll share the payout calendar", meetingId: m1.id, dueAt: "2026-11-20T12:00:00Z" },
    { kind: "waiting", text: "Priya to send the venue quote", person: "Priya", quote: "will send the quote tomorrow", meetingId: m1.id, dueAt: "2026-11-24T12:00:00Z" },
    { kind: "decision", text: "Ship the dividend banner on Friday", person: null, quote: "we ship the banner Friday", meetingId: m1.id, dueAt: null },
  ] });
  for (const i of await store.listItems(user.id)) ids[i.text.split(" ")[0] + i.kind] = i.id;
});

const deps = (client: AiDeps["client"]): AiDeps => ({ store, ai, client, model: "claude-sonnet-5-5", now: () => NOW, retry: { sleep: async () => {} } });

async function addLaterDecision(text: string, quote: string) {
  const m = (await store.upsertMeeting({ userId: user.id, providerMeetingId: "2", title: "Standup", startedAt: "2026-11-25T04:00:00Z", participants: [] })).meeting;
  await store.commitExtraction({ meetingId: m.id, userId: user.id, at: "2026-11-25T05:00:00Z", closes: [], newItems: [{ kind: "decision", text, person: null, quote, meetingId: m.id, dueAt: null }] });
  return (await store.listItems(user.id)).find((i) => i.text === text)!;
}

describe("runNudges", () => {
  it("waits for today's brief, drafts once per overdue item, caches, and logs the cost", async () => {
    const client = fakeCreate(toolCall("write_nudge", { message: "Hey Nitin, any update on the payout calendar?" }));
    expect(await runNudges(deps(client), user)).toBe(0); // no brief yet today
    expect(client.calls).toHaveLength(0);

    await store.saveBrief(user.id, "2026-11-25", "# brief", NOW.toISOString(), "x");
    expect(await runNudges(deps(client), user)).toBe(1); // Priya is only 1 day late
    expect(ai.nudge(ids["Nitinwaiting"])).toMatchObject({ text: "Hey Nitin, any update on the payout calendar?", source: "ai" });
    expect(ai.nudge(ids["Priyawaiting"])).toBeNull();
    const ev = (await store.listEvents("nudge_draft"))[0] as { tokensIn: number; costInr: number };
    expect(ev.tokensIn).toBe(1000);
    expect(ev.costInr).toBeGreaterThan(0);

    // Same day again: nothing. A new copy of the store reads the cache from disk.
    expect(await runNudges(deps(fakeCreate()), user)).toBe(0);
    expect(new AiStore(join(dir, "ai.json")).nudge(ids["Nitinwaiting"])?.text).toContain("payout");
  });
  it("uses the template without an API key and drops nudges for closed items", async () => {
    await store.saveBrief(user.id, "2026-11-25", "# brief", NOW.toISOString(), "x");
    await runNudges(deps(null), user);
    expect(ai.nudge(ids["Nitinwaiting"])).toMatchObject({ source: "template" });
    await store.setItemStatus(ids["Nitinwaiting"], "done", NOW.toISOString());
    const next = { ...deps(null), now: () => new Date("2026-11-26T13:00:00Z") };
    await store.saveBrief(user.id, "2026-11-26", "# brief", NOW.toISOString(), "x");
    await runNudges(next, user);
    expect(ai.nudge(ids["Nitinwaiting"])).toBeNull();
  });
});

describe("runContradictions", () => {
  it("primes on the first run without calls, then flags a new decision that changes an old one", async () => {
    const none = fakeCreate();
    await runContradictions(deps(none), user);
    expect(none.calls).toHaveLength(0);
    expect(ai.primed()).toBe(true);

    const fresh = await addLaterDecision("Ship the dividend banner on Monday instead", "let's push the banner to Monday");
    const client = fakeCreate(toolCall("record_verdict", { changes: true, earlier: 1, note: "banner moved from Friday to Monday" }));
    expect(await runContradictions(deps(client), user)).toBe(1);
    expect(ai.contradictions()).toMatchObject([{ newId: fresh.id, oldId: ids["Shipdecision"], note: "banner moved from Friday to Monday", status: "open" }]);
    // Checked once: no second call.
    expect(await runContradictions(deps(fakeCreate()), user)).toBe(0);
    expect((await store.listEvents("contradiction_check"))).toHaveLength(1);
  });
  it("makes no call for an unrelated decision", async () => {
    await runContradictions(deps(fakeCreate()), user);
    await addLaterDecision("Move standup to 9:30", "standup at 9:30 from Monday");
    const client = fakeCreate();
    await runAiJobs(deps(client), { nudges: false });
    expect(client.calls).toHaveLength(0);
    expect(ai.contradictions()).toEqual([]);
  });
});

describe("key and credit problems", () => {
  it("set the same banner as extraction, stop calling, and resume once it is cleared", async () => {
    await runContradictions(deps(fakeCreate()), user); // prime
    const fresh = await addLaterDecision("Ship the dividend banner on Monday instead", "let's push the banner to Monday");
    await store.saveBrief(user.id, "2026-11-25", "# brief", NOW.toISOString(), "x");
    const credit = fakeCreate(Object.assign(new Error("bad"), { status: 400, error: { error: { message: "Your credit balance is too low to access the Anthropic API." } } }));
    await runAiJobs(deps(credit));
    expect(credit.calls).toHaveLength(1); // no retry, no nudge call after it
    expect((await store.getHealth()).anthropicProblem).toMatchObject({ kind: "credit" });
    expect(ai.checkedSet().has(fresh.id)).toBe(false);
    expect(ai.nudge(ids["Nitinwaiting"])).toBeNull();

    const quiet = fakeCreate();
    await runAiJobs(deps(quiet));
    expect(quiet.calls).toHaveLength(0); // blocked while the banner is up

    await store.setHealth({ anthropicProblem: null }); // e.g. a later extraction worked
    const ok = fakeCreate(
      toolCall("record_verdict", { changes: false, earlier: null, note: "" }),
      toolCall("write_nudge", { message: "Hey Nitin, any update on the payout calendar?" }),
    );
    await runAiJobs(deps(ok));
    expect(ok.calls).toHaveLength(2);
    expect(ai.nudge(ids["Nitinwaiting"])?.source).toBe("ai");
  });
});
