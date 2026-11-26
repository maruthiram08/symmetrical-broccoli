import { describe, expect, it } from "vitest";
import { localDate } from "@/lib/brief/time";
import { isDueOn, dueDatesBetween, lastDone, nextDue, notifyDue, openOccurrences, routineLine, routinesDue, streak } from "./schedule";
import { parseCadence, parseRoutineCapture, parseTimeOfDay } from "./parse";
import { cadenceLabel, cadenceWords, ordinal } from "./words";
import { checkRoutineInput } from "./input";
import { renderRoutinesSection } from "./brief";
import type { Cadence, Occurrence, Routine } from "./types";

const IST = "Asia/Kolkata";
const NY = "America/New_York";

function routine(cadence: Cadence, extra: Partial<Routine> = {}): Routine {
  return {
    id: "r1", userId: "u1", title: "Send sprint report", cadence, time: null, person: null,
    createdAt: "2026-10-01T04:00:00.000Z", archived: false, source: { type: "manual" }, ...extra,
  };
}
const occ = (date: string, status: Occurrence["status"], extra: Partial<Occurrence> = {}): Occurrence => ({ routineId: "r1", date, status, at: "2026-11-01T00:00:00.000Z", ...extra });

// 2026-11-26 is a Thursday.
describe("isDueOn", () => {
  it("daily and weekdays", () => {
    expect(isDueOn({ kind: "daily" }, "2026-11-29")).toBe(true);
    expect(isDueOn({ kind: "weekdays" }, "2026-11-27")).toBe(true); // Fri
    expect(isDueOn({ kind: "weekdays" }, "2026-11-28")).toBe(false); // Sat
    expect(isDueOn({ kind: "weekdays" }, "2026-11-29")).toBe(false); // Sun
    expect(isDueOn({ kind: "weekdays" }, "2026-11-30")).toBe(true); // Mon
  });

  it("weekly on chosen days", () => {
    const c: Cadence = { kind: "weekly", days: [1, 4] };
    expect(dueDatesBetween(c, "2026-11-23", "2026-12-06")).toEqual(["2026-11-23", "2026-11-26", "2026-11-30", "2026-12-03"]);
  });

  it("monthly clamps past the month's end to its last day", () => {
    const c: Cadence = { kind: "monthly", day: 31 };
    expect(isDueOn(c, "2026-04-30")).toBe(true);
    expect(isDueOn(c, "2026-04-29")).toBe(false);
    expect(isDueOn(c, "2026-05-31")).toBe(true);
    expect(isDueOn(c, "2026-05-30")).toBe(false);
    expect(isDueOn(c, "2026-02-28")).toBe(true);
    expect(isDueOn(c, "2028-02-28")).toBe(false); // leap year: the 29th
    expect(isDueOn(c, "2028-02-29")).toBe(true);
    expect(isDueOn({ kind: "monthly", day: 30 }, "2026-02-28")).toBe(true);
    expect(isDueOn({ kind: "monthly", day: 1 }, "2026-12-01")).toBe(true);
    expect(dueDatesBetween({ kind: "monthly", day: 31 }, "2026-01-01", "2026-06-30")).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31", "2026-06-30"]);
  });

  it("every N days from its start", () => {
    const c: Cadence = { kind: "every", n: 3, from: "2026-11-20" };
    expect(dueDatesBetween(c, "2026-11-18", "2026-11-30")).toEqual(["2026-11-20", "2026-11-23", "2026-11-26", "2026-11-29"]);
  });
});

describe("open occurrences and Today's line", () => {
  it("a routine due today shows, ticked it doesn't, and the next comes back on schedule", () => {
    const r = routine({ kind: "weekly", days: [4] }); // Thursdays
    expect(routineLine(r, [occ("2026-11-19", "done")], "2026-11-26", IST)).toMatchObject({ date: "2026-11-26", overdueSince: null, overdueLabel: null });
    const ticked = [occ("2026-11-19", "done"), occ("2026-11-26", "done")];
    expect(routineLine(r, ticked, "2026-11-26", IST)).toBeNull();
    expect(routineLine(r, ticked, "2026-11-27", IST)).toBeNull();
    expect(routineLine(r, ticked, "2026-12-03", IST)).toMatchObject({ date: "2026-12-03", overdueSince: null });
    expect(nextDue(r, ticked, "2026-11-26", IST)).toBe("2026-12-03");
  });

  it("missed days since the last done are overdue, within a week", () => {
    const r = routine({ kind: "daily" });
    const line = routineLine(r, [occ("2026-11-22", "done")], "2026-11-26", IST)!;
    expect(line).toMatchObject({ date: "2026-11-26", overdueSince: "2026-11-23", overdueLabel: "overdue since Mon" });
    // Long gaps are let go after 7 days.
    expect(openOccurrences(r, [occ("2026-11-01", "done")], "2026-11-26", IST)).toEqual(["2026-11-20", "2026-11-21", "2026-11-22", "2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26"]);
  });

  it("a routine not due today shows its latest missed day, overdue", () => {
    const r = routine({ kind: "weekly", days: [1] }); // Mondays
    expect(routineLine(r, [], "2026-11-26", IST)).toMatchObject({ date: "2026-11-23", overdueSince: "2026-11-23", overdueLabel: "overdue since Mon" });
    // Ticking that Monday clears it until next Monday.
    expect(routineLine(r, [occ("2026-11-23", "done")], "2026-11-26", IST)).toBeNull();
  });

  it("skipping counts as handled; nothing is due before the routine started", () => {
    const r = routine({ kind: "daily" }, { createdAt: "2026-11-25T18:00:00.000Z" }); // 25 Nov 23:30 IST
    expect(openOccurrences(r, [], "2026-11-26", IST)).toEqual(["2026-11-25", "2026-11-26"]);
    expect(openOccurrences(r, [occ("2026-11-26", "skipped")], "2026-11-26", IST)).toEqual([]);
    expect(openOccurrences({ ...r, archived: true }, [], "2026-11-26", IST)).toEqual([]);
  });

  it("a snoozed occurrence stays away until its day, then comes back overdue", () => {
    const r = routine({ kind: "weekly", days: [4] });
    const snoozed = [occ("2026-11-19", "done"), occ("2026-11-26", "snoozed", { until: "2026-11-27" })];
    expect(routineLine(r, snoozed, "2026-11-26", IST)).toBeNull();
    expect(routineLine(r, snoozed, "2026-11-27", IST)).toMatchObject({ date: "2026-11-26", overdueLabel: "overdue since Thu" });
    // Snoozed isn't done: the next due date is still that day.
    expect(nextDue(r, snoozed, "2026-11-26", IST)).toBe("2026-11-26");
  });

  it("routinesDue puts today's first, by time, then the overdue-only ones", () => {
    const a = routine({ kind: "daily" }, { id: "a", title: "Inbox zero", time: "17:00" });
    const b = routine({ kind: "daily" }, { id: "b", title: "Standup notes", time: "09:30" });
    const c = routine({ kind: "weekly", days: [1] }, { id: "c", title: "Plan week" });
    const done = (id: string, date: string): Occurrence => ({ routineId: id, date, status: "done", at: "x" });
    const lines = routinesDue([a, b, c], [done("a", "2026-11-25"), done("b", "2026-11-25")], "2026-11-26", IST);
    expect(lines.map((l) => l.title)).toEqual(["Standup notes", "Inbox zero", "Plan week"]);
  });

  it("last done and streaks: skips are passed over, a miss ends it, today counts once done", () => {
    const r = routine({ kind: "weekdays" });
    const o = [occ("2026-11-19", "done"), occ("2026-11-20", "done"), occ("2026-11-23", "skipped"), occ("2026-11-24", "done"), occ("2026-11-25", "done")];
    expect(lastDone(o, "r1")).toBe("2026-11-25");
    expect(streak(r, o, "2026-11-26", IST)).toBe(4);
    expect(streak(r, [...o, occ("2026-11-26", "done")], "2026-11-26", IST)).toBe(5);
    expect(streak(r, o.filter((x) => x.date !== "2026-11-20"), "2026-11-26", IST)).toBe(2);
    expect(streak(r, [], "2026-11-26", IST)).toBe(0);
  });
});

describe("time zones", () => {
  it("the local day decides what's due (Asia/Kolkata, no DST)", () => {
    const r = routine({ kind: "weekly", days: [5] }); // Fridays
    // 2026-11-26 19:00Z is Fri 27 Nov 00:30 in Kolkata.
    const today = localDate(new Date("2026-11-26T19:00:00Z"), IST);
    expect(today).toBe("2026-11-27");
    expect(routineLine(r, [], today, IST)?.date).toBe("2026-11-27");
    expect(localDate(new Date("2026-11-26T18:00:00Z"), IST)).toBe("2026-11-26");
  });

  it("a timed routine notifies at its local time across a DST change (America/New_York)", () => {
    const r = routine({ kind: "daily" }, { time: "09:00", createdAt: "2026-10-01T12:00:00.000Z" });
    // Sat 31 Oct is EDT (UTC-4): 09:00 is 13:00Z. Sun 1 Nov is EST (UTC-5): 09:00 is 14:00Z.
    expect(notifyDue(r, [], new Date("2026-10-31T12:59:00Z"), NY)).toBeNull();
    expect(notifyDue(r, [], new Date("2026-10-31T13:00:00Z"), NY)).toBe("2026-10-31");
    expect(notifyDue(r, [], new Date("2026-11-01T13:30:00Z"), NY)).toBeNull();
    expect(notifyDue(r, [], new Date("2026-11-01T14:05:00Z"), NY)).toBe("2026-11-01");
    // Spring forward: Sun 8 Mar 2026 is EDT, so 09:00 is 13:00Z (Sat 7 Mar was EST: 14:00Z).
    const early = { ...r, createdAt: "2026-01-01T12:00:00.000Z" };
    expect(notifyDue(early, [], new Date("2026-03-07T13:30:00Z"), NY)).toBeNull();
    expect(notifyDue(early, [], new Date("2026-03-07T14:01:00Z"), NY)).toBe("2026-03-07");
    expect(notifyDue(early, [], new Date("2026-03-08T13:01:00Z"), NY)).toBe("2026-03-08");
    // Monday 2 Nov, 23:30 EST is already 3 Nov in UTC, still the 2nd locally.
    expect(localDate(new Date("2026-11-03T04:30:00Z"), NY)).toBe("2026-11-02");
  });

  it("no notification when done, skipped or snoozed, too late, untimed or not due", () => {
    const r = routine({ kind: "weekly", days: [4] }, { time: "10:00" });
    const at = new Date("2026-11-26T04:31:00Z"); // 10:01 IST, Thursday
    expect(notifyDue(r, [], at, IST)).toBe("2026-11-26");
    expect(notifyDue(r, [occ("2026-11-26", "done")], at, IST)).toBeNull();
    expect(notifyDue(r, [occ("2026-11-26", "skipped")], at, IST)).toBeNull();
    expect(notifyDue(r, [occ("2026-11-26", "snoozed", { until: "2026-11-27" })], at, IST)).toBeNull();
    expect(notifyDue(r, [], new Date("2026-11-26T07:00:00Z"), IST)).toBeNull(); // 12:30, over two hours late
    expect(notifyDue({ ...r, time: null }, [], at, IST)).toBeNull();
    expect(notifyDue(r, [], new Date("2026-11-27T04:31:00Z"), IST)).toBeNull(); // Friday
  });
});

describe("plain words", () => {
  it("says the cadence the way people do", () => {
    expect(cadenceLabel({ kind: "weekly", days: [5] }, null)).toBe("Every Friday");
    expect(cadenceLabel({ kind: "weekdays" }, "10:00")).toBe("Weekdays at 10:00");
    expect(cadenceLabel({ kind: "monthly", day: 1 }, null)).toBe("Monthly on the 1st");
    expect(cadenceWords({ kind: "weekly", days: [4, 1] })).toBe("Every Monday and Thursday");
    expect(cadenceWords({ kind: "weekly", days: [0, 1, 3, 5] })).toBe("Every Mon, Wed, Fri and Sun");
    expect(cadenceWords({ kind: "weekly", days: [0, 6] })).toBe("Weekends");
    expect(cadenceWords({ kind: "daily" })).toBe("Every day");
    expect(cadenceWords({ kind: "every", n: 2, from: "2026-11-26" })).toBe("Every other day");
    expect(cadenceWords({ kind: "every", n: 10, from: "2026-11-26" })).toBe("Every 10 days");
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "31st"]);
  });
});

describe("parseCadence", () => {
  const A = "2026-11-26"; // Thursday
  const cases: Array<[string, Cadence, string | null]> = [
    ["every Monday", { kind: "weekly", days: [1] }, null],
    ["every Monday and Thursday at 10am", { kind: "weekly", days: [1, 4] }, "10:00"],
    ["on Fridays", { kind: "weekly", days: [5] }, null],
    ["weekly", { kind: "weekly", days: [4] }, null],
    ["weekly on Fri at 6 pm", { kind: "weekly", days: [5] }, "18:00"],
    ["weekdays at 10:00", { kind: "weekdays" }, "10:00"],
    ["every day", { kind: "daily" }, null],
    ["daily at 9:30", { kind: "daily" }, "09:30"],
    ["monthly on the 1st", { kind: "monthly", day: 1 }, null],
    ["on the 15th of every month", { kind: "monthly", day: 15 }, null],
    ["each month", { kind: "monthly", day: 26 }, null],
    ["at the end of every month", { kind: "monthly", day: 31 }, null],
    ["every 3 days", { kind: "every", n: 3, from: A }, null],
    ["every other day", { kind: "every", n: 2, from: A }, null],
    ["every 2 weeks", { kind: "every", n: 14, from: A }, null],
    ["har Friday", { kind: "weekly", days: [5] }, null],
    ["har din 10 baje", { kind: "daily" }, "10:00"],
    ["roz", { kind: "daily" }, null],
    ["har mahine", { kind: "monthly", day: 26 }, null],
    ["har somvaar", { kind: "weekly", days: [1] }, null],
  ];
  for (const [text, cadence, time] of cases) {
    it(text, () => expect(parseCadence(text, A)).toMatchObject({ cadence, time }));
  }

  it("reads a whole Hinglish or English promise, leaving the task", () => {
    expect(parseCadence("har Friday main update bhejunga", A)).toMatchObject({ cadence: { kind: "weekly", days: [5] }, rest: "main update bhejunga" });
    expect(parseCadence("weekly I'll share the metrics", A)).toMatchObject({ cadence: { kind: "weekly", days: [4] }, rest: "I'll share the metrics" });
  });

  it("finds nothing in one-off lines", () => {
    for (const s of ["send Nitin the deck by Fri", "call Tarun on Thurs", "review the doc tomorrow", "send 2 decks", "everything is fine"]) {
      expect(parseCadence(s, A), s).toBeNull();
    }
  });

  it("times: chrono for the clock, never a bare number", () => {
    expect(parseTimeOfDay("send report at 5").time).toBe("05:00");
    expect(parseTimeOfDay("send 2 decks").time).toBeNull();
    expect(parseTimeOfDay("standup notes 9:15am")).toEqual({ time: "09:15", rest: "standup notes" });
  });
});

describe("quick capture", () => {
  const ctx = { people: ["Tarun"], self: ["Maruthi"], now: new Date("2026-11-26T06:00:00Z"), timeZone: IST };
  it("every Monday send sprint report to Tarun", () => {
    expect(parseRoutineCapture("every Monday send sprint report to Tarun", ctx)).toEqual({
      title: "Send sprint report to Tarun", person: "Tarun", cadence: { kind: "weekly", days: [1] }, time: null,
    });
  });
  it("weekdays at 10 post the standup notes", () => {
    expect(parseRoutineCapture("weekdays at 10:00 post the standup notes", ctx)).toMatchObject({ title: "Post the standup notes", cadence: { kind: "weekdays" }, time: "10:00" });
  });
  it("leaves one-off items and things others owe you alone", () => {
    expect(parseRoutineCapture("send Tarun the deck by Fri", ctx)).toBeNull();
    expect(parseRoutineCapture("Tarun will send the report every Monday", ctx)).toBeNull();
  });
});

describe("checkRoutineInput", () => {
  it("accepts a good routine and normalizes days", () => {
    const r = checkRoutineInput({ title: " Pay rent ", cadence: { kind: "weekly", days: [5, 1, 5] }, time: "", person: "" });
    expect(r).toEqual({ ok: true, value: { title: "Pay rent", cadence: { kind: "weekly", days: [1, 5] }, time: null, person: null } });
  });
  it("says what's wrong", () => {
    expect(checkRoutineInput({ title: "", cadence: { kind: "daily" } })).toMatchObject({ ok: false, error: "Say what it is." });
    expect(checkRoutineInput({ title: "x", cadence: { kind: "weekly", days: [] } })).toMatchObject({ ok: false, error: "Pick at least one day." });
    expect(checkRoutineInput({ title: "x", cadence: { kind: "monthly", day: 32 } })).toMatchObject({ ok: false });
    expect(checkRoutineInput({ title: "x", cadence: { kind: "daily" }, time: "25:00" })).toMatchObject({ ok: false });
    expect(checkRoutineInput({ title: "x", cadence: { kind: "every", n: 1, from: "2026-11-26" } })).toMatchObject({ ok: false });
  });
});

describe("brief section", () => {
  it("lists routines due, red-flagged words only when overdue", () => {
    expect(renderRoutinesSection([])).toEqual([]);
    const md = renderRoutinesSection([
      { routineId: "a", title: "Send sprint report", person: "Tarun", time: "10:00", cadenceLabel: "Every Friday at 10:00", date: "2026-11-27", overdueSince: null, overdueLabel: null },
      { routineId: "b", title: "Pay rent", person: null, time: null, cadenceLabel: "Monthly on the 1st", date: "2026-11-01", overdueSince: "2026-11-01", overdueLabel: "overdue since 1 Nov" },
    ]).join("\n");
    expect(md).toBe("## Routines due today\n\n- [ ] Send sprint report (10:00)\n  Every Friday at 10:00 · Tarun\n- [ ] Pay rent **(overdue since 1 Nov)**\n  Monthly on the 1st\n");
  });
});
