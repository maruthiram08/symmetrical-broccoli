import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BriefModel } from "@/lib/types";
import { FileStore } from "./file-store";
import { notificationBody, publishLocal } from "./publish";

const tmp = () => mkdtempSync(join(tmpdir(), "db-local-"));

describe("FileStore", () => {
  it("keeps everything across restarts, with unique ids and private file mode", async () => {
    const path = join(tmp(), ".daily-brief", "state.json");
    const a = new FileStore(path);
    const u = a.addUser({ email: "you@this-mac", name: "Maruthi" });
    const { meeting } = await a.upsertMeeting({ userId: u.id, providerMeetingId: "p1", title: "Standup", startedAt: "2026-11-25T05:30:00Z", participants: [] });
    await a.commitExtraction({ meetingId: meeting.id, userId: u.id, at: "2026-11-25T06:00:00Z", closes: [], newItems: [
      { kind: "owe", text: "Send Nitin the banner text", person: "Nitin", quote: "I'll send it", meetingId: meeting.id, dueAt: null },
    ] });
    await a.saveOAuthClient(u.id, { client_id: "abc" });
    await a.saveBrief(u.id, "2026-11-25", "# hi", "2026-11-25T12:30:00Z", "x");

    const b = new FileStore(path);
    expect((await b.getUser(u.id))?.name).toBe("Maruthi");
    expect((await b.getMeeting(meeting.id))?.processedAt).toBe("2026-11-25T06:00:00Z");
    const items = await b.listItems(u.id);
    expect(items.map((i) => i.text)).toEqual(["Send Nitin the banner text"]);
    expect(items[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await b.getOAuthClient(u.id)).toEqual({ client_id: "abc" });
    expect(await b.getBrief(u.id, "2026-11-25")).toEqual({ sentAt: "2026-11-25T12:30:00Z" });
    expect(statSync(path).mode & 0o777).toBe(0o600);

    // a second commit of the same meeting writes nothing
    await b.commitExtraction({ meetingId: meeting.id, userId: u.id, at: "2026-11-25T07:00:00Z", closes: [], newItems: [
      { kind: "owe", text: "Duplicate", person: null, quote: "x", meetingId: meeting.id, dueAt: null },
    ] });
    expect(await b.listItems(u.id)).toHaveLength(1);
  });
});

const model = (over: Partial<BriefModel> = {}): BriefModel => ({
  userId: "u", date: "2026-11-25", dateLabel: "Wednesday, 25 November", meetingCount: 1,
  wrap: { meetings: 1, made: 1, kept: 0, late: 1 }, waitingOn: [], closedToday: [], stillOpen: [], stillOpenCount: 0, empty: null,
  subject: "Your day: 1 overdue, 1 decision",
  youOwe: [{ itemId: "i", kind: "owe", text: "Send Nitin the banner text", person: "Nitin", quote: "q", meetingTitle: "M", meetingTime: "1:51 PM", dueLabel: null, lateMinutes: 240, lateLabel: "4h late" }],
  decisions: [{ itemId: "d", kind: "decision", text: "Ship on Friday", person: null, quote: "let's ship Friday", meetingTitle: "M", meetingTime: "1:51 PM", dueLabel: null, lateMinutes: null, lateLabel: null }],
  ...over,
});

describe("publishLocal", () => {
  it("writes the day's note, appends decisions once, and notifies", async () => {
    const dir = tmp();
    const shown: string[][] = [];
    const notify = (t: string, b: string) => { shown.push([t, b]); };
    const r = await publishLocal(dir, {} as never, model(), "# Wednesday\n", notify);
    expect(r.id).toBe(join(dir, "2026-11-25.md"));
    expect(readFileSync(r.id, "utf8")).toBe("# Wednesday\n");
    await publishLocal(dir, {} as never, model(), "# Wednesday\n", notify);
    const decisions = readFileSync(join(dir, "decisions.md"), "utf8");
    expect(decisions.match(/Ship on Friday/g)).toHaveLength(1);
    expect(shown[0]).toEqual(["Your day: 1 overdue, 1 decision", "Send Nitin the banner text (4h late)"]);
  });
  it("notification copy for empty days", () => {
    expect(notificationBody(model({ empty: "nothing_owed", youOwe: [] }))).toBe("Nothing owed. Go home.");
    expect(notificationBody(model({ empty: "no_meetings", youOwe: [] }))).toBe("No meetings today.");
  });
});

describe("FileStore across copies", () => {
  it("a second copy sees the first copy's commit, so a meeting is never committed twice", async () => {
    const path = join(tmp(), "state.json");
    const a = new FileStore(path);
    const u = a.addUser({ email: "x" });
    const { meeting } = await a.upsertMeeting({ userId: u.id, providerMeetingId: "p", title: "T", startedAt: "2026-11-25T05:00:00Z", participants: [] });
    const b = new FileStore(path);
    const item = { kind: "owe" as const, text: "Do it", person: null, quote: "q", meetingId: meeting.id, dueAt: null };
    await a.commitExtraction({ meetingId: meeting.id, userId: u.id, at: "2026-11-25T06:00:00.000Z", closes: [], newItems: [item] });
    await new Promise((r) => setTimeout(r, 5));
    await b.commitExtraction({ meetingId: meeting.id, userId: u.id, at: "2026-11-25T06:00:01.000Z", closes: [], newItems: [item] });
    expect(await new FileStore(path).listItems(u.id)).toHaveLength(1);
  });

  it("removes a second batch from a meeting read twice, on load", async () => {
    const path = join(tmp(), "state.json");
    const a = new FileStore(path);
    const u = a.addUser({ email: "x" });
    const mk = (id: string, at: string) => ({ id, userId: u.id, kind: "owe" as const, text: id, person: null, quote: "q", meetingId: "m1", dueAt: null, status: "open" as const, closedByMeetingId: null, closeQuote: null, createdAt: at, closedAt: null });
    for (const i of [mk("a1", "2026-11-25T06:00:00Z"), mk("a2", "2026-11-25T06:00:00Z"), mk("b1", "2026-11-25T06:00:01Z")]) a.items.set(i.id, i);
    a.flush();
    expect((await new FileStore(path).listItems(u.id)).map((i) => i.id).sort()).toEqual(["a1", "a2"]);
  });
});

describe("last look and weekly note", () => {
  it("keeps the last look across restarts and still loads a state file without one", async () => {
    const path = join(tmp(), "state.json");
    const a = new FileStore(path);
    const u = a.addUser({ email: "x" });
    expect(await a.getLastLook(u.id)).toBeNull();
    // An older state.json has no "looks" key.
    const raw = JSON.parse(readFileSync(path, "utf8"));
    expect(raw.looks).toEqual([]);
    delete raw.looks;
    writeFileSync(path, JSON.stringify(raw));
    const b = new FileStore(path);
    expect(await b.getUser(u.id)).not.toBeNull();
    expect(await b.getLastLook(u.id)).toBeNull();
    await b.saveLastLook(u.id, { lastLookedAt: "2026-11-25T12:00:00.000Z", since: null });
    expect(await new FileStore(path).getLastLook(u.id)).toEqual({ lastLookedAt: "2026-11-25T12:00:00.000Z", since: null });
  });

  it("publishLocal writes the week note when given one", async () => {
    const dir = tmp();
    await publishLocal(dir, {} as never, model(), "# Friday\n", () => {}, { key: "2026-W48", markdown: "# Week 48\n" });
    expect(readFileSync(join(dir, "week-2026-W48.md"), "utf8")).toBe("# Week 48\n");
    expect(readFileSync(join(dir, "2026-11-25.md"), "utf8")).toBe("# Friday\n");
  });
});
