import { describe, expect, it } from "vitest";
import { MemoryStore } from "@/server/store";
import { buildBrief, subjectFor } from "./build";
import { renderDecisionsAppend, renderMarkdown } from "./markdown";
import { dateLabel, dueLabel, formatTime, lateLabel, localDate, localDayBounds, zonedTime } from "./time";

const TZ = "Asia/Kolkata";

describe("time helpers", () => {
  it("finds the local day in IST", () => {
    expect(localDate(new Date("2026-11-25T19:00:00Z"), TZ)).toBe("2026-11-26"); // 00:30 IST
    expect(localDayBounds("2026-11-25", TZ)).toEqual({ startIso: "2026-11-24T18:30:00.000Z", endIso: "2026-11-25T18:30:00.000Z" });
  });
  it("handles a DST zone", () => {
    expect(zonedTime("2026-03-08", "18:00", "America/New_York").toISOString()).toBe("2026-03-08T22:00:00.000Z");
    expect(zonedTime("2026-03-07", "18:00", "America/New_York").toISOString()).toBe("2026-03-07T23:00:00.000Z");
  });
  it("formats times and labels", () => {
    expect(formatTime("2026-11-25T08:21:00Z", TZ)).toBe("1:51 PM");
    expect(dateLabel("2026-11-25")).toBe("Wednesday, 25 November");
    const now = new Date("2026-11-25T10:00:00Z");
    expect(dueLabel("2026-11-25T12:00:00Z", now, TZ)).toBe("Today");
    expect(dueLabel("2026-11-26T12:00:00Z", now, TZ)).toBe("Tomorrow");
    expect(dueLabel("2026-11-28T12:00:00Z", now, TZ)).toBe("Sat");
    expect(dueLabel("2026-12-03T12:00:00Z", now, TZ)).toBe("3 Dec");
    expect([lateLabel(0), lateLabel(45), lateLabel(250), lateLabel(3000)]).toEqual(["1m late", "45m late", "4h late", "2d late"]);
  });
});

async function seed() {
  const s = new MemoryStore();
  const user = s.addUser({ email: "m@example.com", name: "Maruthi", timeZone: TZ });
  const meet = async (pid: string, title: string, startedAt: string) => {
    const { meeting } = await s.upsertMeeting({ userId: user.id, providerMeetingId: pid, title, startedAt, participants: [] });
    return meeting;
  };
  const add = async (meetingId: string, at: string, items: Array<{ kind: "owe" | "waiting" | "decision"; text: string; dueAt?: string; person?: string }>, closes: Array<{ itemId: string; quote: string }> = []) => {
    await s.commitExtraction({
      meetingId, userId: user.id, at, closes,
      newItems: items.map((i) => ({ kind: i.kind, text: i.text, person: i.person ?? null, quote: `quote for ${i.text}`, meetingId, dueAt: i.dueAt ?? null })),
    });
  };
  return { s, user, meet, add };
}

describe("buildBrief", () => {
  const now = new Date("2026-11-25T12:12:00Z"); // 5:42 PM IST

  it("builds sections, puts overdue first, shows what closed today", async () => {
    const { s, user, meet, add } = await seed();
    const old = await meet("m0", "Planning", "2026-11-20T05:00:00Z");
    await add(old.id, "2026-11-20T06:00:00Z", [
      { kind: "owe", text: "Share the deck with Tarun" },
      { kind: "waiting", text: "Tarun confirms timeline", person: "Tarun" },
      { kind: "owe", text: "Old thing one" },
    ]);
    const deck = [...s.items.values()].find((i) => i.text === "Share the deck with Tarun")!;
    const banner = await meet("m1", "Dividend banner", "2026-11-25T08:21:00Z");
    await add(banner.id, "2026-11-25T09:00:00Z", [
      { kind: "owe", text: "Send Nitin the final banner text", person: "Nitin", dueAt: "2026-11-25T08:51:00Z" },
      { kind: "owe", text: "Review copy", dueAt: "2026-11-26T10:00:00Z" },
      { kind: "decision", text: "Ship the banner on Friday" },
    ], [{ itemId: deck.id, quote: "Got the deck, thanks" }]);

    const b = await buildBrief(s, user, now);
    expect(b.date).toBe("2026-11-25");
    expect(b.meetingCount).toBe(1);
    expect(b.youOwe.map((l) => l.text)).toEqual(["Send Nitin the final banner text", "Review copy"]);
    expect(b.youOwe[0].lateLabel).toBe("3h late");
    expect(b.youOwe[0].meetingTime).toBe("1:51 PM");
    expect(b.youOwe[1].dueLabel).toBe("Tomorrow");
    expect(b.decisions.map((l) => l.text)).toEqual(["Ship the banner on Friday"]);
    expect(b.closedToday).toEqual([{ itemId: deck.id, text: "Share the deck with Tarun", closeQuote: "Got the deck, thanks", closedInMeeting: "Dividend banner", closedAtTime: "1:51 PM" }]);
    expect(b.stillOpen.map((l) => l.text).sort()).toEqual(["Old thing one", "Tarun confirms timeline"]);
    expect(b.stillOpenCount).toBe(2);
    expect(b.wrap).toEqual({ meetings: 1, made: 2, kept: 1, late: 1 });
    expect(b.empty).toBeNull();
    expect(b.subject).toBe("Your day: 1 overdue, 1 owed, 1 decision");

    const md = renderMarkdown(b);
    expect(md).toContain("# Wednesday, 25 November");
    expect(md).toContain("- [ ] Send Nitin the final banner text **(3h late)**");
    expect(md).toContain("## Closed today");
    expect(md).toContain("## Still open from before (2)");
    expect(renderDecisionsAppend(b)).toContain("2026-11-25 · Ship the banner on Friday");
  });

  it("says nothing owed and no meetings", async () => {
    const { s, user, meet, add } = await seed();
    let b = await buildBrief(s, user, now);
    expect(b.empty).toBe("no_meetings");
    expect(b.subject).toBe("Your day: no meetings, nothing open");
    const m = await meet("m1", "Standup", "2026-11-25T05:30:00Z");
    await add(m.id, "2026-11-25T06:00:00Z", [{ kind: "waiting", text: "Asha sends numbers", person: "Asha" }]);
    b = await buildBrief(s, user, now);
    expect(b.empty).toBe("nothing_owed");
    expect(renderMarkdown(b)).toContain("**Nothing owed. Go home.**");
  });

  it("ignores items marked wrong and unprocessed meetings", async () => {
    const { s, user, meet, add } = await seed();
    const m = await meet("m1", "Standup", "2026-11-25T05:30:00Z");
    await add(m.id, "2026-11-25T06:00:00Z", [{ kind: "owe", text: "Wrong one" }]);
    const it = [...s.items.values()][0];
    await s.setItemStatus(it.id, "wrong", now.toISOString());
    await meet("m2", "Not yet processed", "2026-11-25T07:00:00Z");
    const b = await buildBrief(s, user, now);
    expect(b.youOwe).toEqual([]);
    expect(b.meetingCount).toBe(1);
  });

  it("escapes Markdown in transcript text", () => {
    const md = renderMarkdown({
      userId: "u", date: "2026-11-25", dateLabel: "Wednesday, 25 November", meetingCount: 1,
      wrap: { meetings: 1, made: 1, kept: 0, late: 0 }, waitingOn: [], decisions: [], closedToday: [], stillOpen: [], stillOpenCount: 0, empty: null, subject: "",
      youOwe: [{ itemId: "i", kind: "owe", text: "Fix *the* [link]\n# now", person: null, quote: "q", meetingTitle: "M", meetingTime: "1:00 PM", dueLabel: null, lateMinutes: null, lateLabel: null }],
    });
    expect(md).toContain("- [ ] Fix \\*the\\* \\[link\\] \\# now");
  });
});

describe("subjectFor", () => {
  it("summarises", () => {
    expect(subjectFor({ owe: 0, late: 0, waiting: 0, decisions: 0, meetings: 2, stillOpen: 0 })).toBe("Your day: nothing owed");
    expect(subjectFor({ owe: 0, late: 0, waiting: 0, decisions: 0, meetings: 0, stillOpen: 3 })).toBe("Your day: no meetings, 3 still open");
  });
});
