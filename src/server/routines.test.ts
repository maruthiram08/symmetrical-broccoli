import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildBrief } from "@/lib/brief/build";
import { renderMarkdown } from "@/lib/brief/markdown";
import { briefDigest, briefSummary, digestText } from "@/lib/channels/digest";
import { renderDaily } from "@/lib/templates/daily";
import type { Routine } from "@/lib/routines/types";
import { MemoryStore } from "./store";
import { FileStore } from "./local/file-store";
import { notificationBody } from "./local/publish";
import { notifyRoutines } from "./local/routine-notify";
import { routineStore } from "./routines";

const tmp = () => mkdtempSync(join(tmpdir(), "db-routines-"));
// Thursday 26 Nov 2026, 15:30 in Kolkata.
const NOW = new Date("2026-11-26T10:00:00.000Z");

const routine = (userId: string, extra: Partial<Routine> = {}): Routine => ({
  id: "r-1", userId, title: "Send sprint report", cadence: { kind: "weekly", days: [4] }, time: "10:00", person: "Tarun",
  createdAt: "2026-11-01T04:00:00.000Z", archived: false, source: { type: "manual" }, ...extra,
});

describe("routine store", () => {
  it("MemoryStore adds, edits, marks one occurrence and deletes", async () => {
    const s = new MemoryStore();
    const u = s.addUser({ email: "a@x" });
    expect(routineStore(s)).toBe(s);
    await s.saveRoutine(routine(u.id));
    await s.saveRoutine(routine(u.id, { title: "Send the sprint report" }));
    expect((await s.listRoutines(u.id)).map((r) => r.title)).toEqual(["Send the sprint report"]);
    expect(await s.setOccurrence(u.id, "r-1", "2026-11-26", { status: "done" }, NOW.toISOString())).toBe(true);
    expect(await s.setOccurrence(u.id, "r-1", "2026-11-26", { status: "skipped" }, NOW.toISOString())).toBe(true);
    expect(await s.listOccurrences(u.id)).toEqual([{ routineId: "r-1", date: "2026-11-26", status: "skipped", at: NOW.toISOString() }]);
    expect(await s.setOccurrence(u.id, "nope", "2026-11-26", { status: "done" }, "x")).toBe(false);
    expect(await s.markRoutineNotified(u.id, "r-1:2026-11-26")).toBe(true);
    expect(await s.markRoutineNotified(u.id, "r-1:2026-11-26")).toBe(false);
    expect(await s.deleteRoutine(u.id, "r-1")).toBe(true);
    expect(await s.listOccurrences(u.id)).toEqual([]);
    expect(await s.deleteRoutine(u.id, "r-1")).toBe(false);
  });

  it("FileStore keeps routines across restarts, and older files without them still load", async () => {
    const path = join(tmp(), ".daily-brief", "state.json");
    const a = new FileStore(path);
    const u = a.addUser({ email: "a@x", name: "Maruthi" });
    const raw = JSON.parse(readFileSync(path, "utf8"));
    expect(raw.routines).toBeUndefined(); // nothing written until there are routines
    await a.saveRoutine(routine(u.id));
    await a.setOccurrence(u.id, "r-1", "2026-11-19", { status: "done" }, NOW.toISOString());
    expect(await a.addRoutineSuggestions(u.id, [{ title: "Share metrics", cadence: { kind: "weekly", days: [1] }, time: null, person: null, meetingId: "m1", quote: "Weekly I'll share", recurrence: "weekly", createdAt: NOW.toISOString() }])).toBe(1);
    expect(await a.addRoutineSuggestions(u.id, [{ title: "Again", cadence: { kind: "daily" }, time: null, person: null, meetingId: "m1", quote: "weekly  I'll share", recurrence: "weekly", createdAt: NOW.toISOString() }])).toBe(0);

    const b = new FileStore(path);
    expect((await b.listRoutines(u.id)).map((r) => r.title)).toEqual(["Send sprint report"]);
    expect(await b.listOccurrences(u.id)).toHaveLength(1);
    expect((await b.listRoutineSuggestions(u.id)).map((x) => x.title)).toEqual(["Share metrics"]);

    // A state file from before routines.
    const old = join(tmp(), "state.json");
    const s = JSON.parse(readFileSync(path, "utf8"));
    delete s.routines;
    writeFileSync(old, JSON.stringify(s));
    const c = new FileStore(old);
    expect(await c.listRoutines(u.id)).toEqual([]);
    await c.deleteUser(u.id);
  });
});

describe("routines on Today and in the brief", () => {
  async function setup() {
    const s = new MemoryStore();
    const u = s.addUser({ email: "a@x", name: "Maruthi", timeZone: "Asia/Kolkata" });
    await s.saveRoutine(routine(u.id));
    await s.saveRoutine(routine(u.id, { id: "r-2", title: "Pay rent", cadence: { kind: "monthly", day: 24 }, time: null, person: null }));
    await s.saveRoutine(routine(u.id, { id: "r-3", title: "Old thing", archived: true }));
    return { s, u };
  }

  it("lists today's and overdue routines without touching item counts", async () => {
    const { s, u } = await setup();
    const b = await buildBrief(s, u, NOW);
    expect(b.routines?.map((r) => [r.title, r.date, r.overdueLabel])).toEqual([
      ["Send sprint report", "2026-11-26", null],
      ["Pay rent", "2026-11-24", "overdue since Tue"],
    ]);
    expect(b.stillOpenCount).toBe(0);
    expect(b.youOwe).toEqual([]);

    const md = renderMarkdown(b);
    expect(md).toContain("## Routines due today\n\n- [ ] Send sprint report (10:00)\n  Every Thursday at 10:00 · Tarun\n- [ ] Pay rent **(overdue since Tue)**");
    // The template path writes the same section.
    expect(renderDaily(b)).toContain("## Routines due today");

    const d = briefDigest(b);
    const sec = d.sections.find((x) => x.title === "Routines due today")!;
    expect(sec.count).toBe("2 due");
    expect(sec.lines.map((l) => [l.text, l.side, l.late, l.n])).toEqual([["Send sprint report", "10:00", false, undefined], ["Pay rent", "overdue since Tue", true, undefined]]);
    expect(d.numbers).toEqual([]); // "/done 3" numbers are for items only
    expect(digestText(d)).toContain("Routines due today (2 due)");
    expect(briefSummary(b)).toContain("2 routines due");
    expect(notificationBody(b)).toBe("No meetings today. · 2 routines due");
  });

  it("ticking one occurrence takes it off; nothing shows when none are due", async () => {
    const { s, u } = await setup();
    await s.setOccurrence(u.id, "r-1", "2026-11-26", { status: "done" }, NOW.toISOString());
    await s.setOccurrence(u.id, "r-2", "2026-11-24", { status: "skipped" }, NOW.toISOString());
    const b = await buildBrief(s, u, NOW);
    expect(b.routines).toBeUndefined();
    expect(renderMarkdown(b)).not.toContain("Routines");
    expect(briefDigest(b).sections.map((x) => x.title)).not.toContain("Routines due today");
    // Next Thursday it's back.
    expect((await buildBrief(s, u, new Date("2026-12-03T05:00:00Z"))).routines?.map((r) => r.title)).toEqual(["Send sprint report"]);
  });
});

describe("routine notifications", () => {
  it("go out once per occurrence after the time, never when done", async () => {
    const s = new MemoryStore();
    const u = s.addUser({ email: "a@x", timeZone: "Asia/Kolkata" });
    await s.saveRoutine(routine(u.id));
    const sent: string[][] = [];
    const notify = (t: string, b: string) => { sent.push([t, b]); };
    expect(await notifyRoutines(s, new Date("2026-11-26T04:25:00Z"), notify)).toBe(0); // 09:55
    expect(await notifyRoutines(s, new Date("2026-11-26T04:31:00Z"), notify)).toBe(1); // 10:01
    expect(await notifyRoutines(s, new Date("2026-11-26T04:36:00Z"), notify)).toBe(0); // already sent
    expect(sent).toEqual([["Send sprint report", "Every Thursday at 10:00 · for Tarun"]]);
    await s.setOccurrence(u.id, "r-1", "2026-12-03", { status: "done" }, "x");
    expect(await notifyRoutines(s, new Date("2026-12-03T04:31:00Z"), notify)).toBe(0);
  });
});
