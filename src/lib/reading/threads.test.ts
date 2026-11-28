import { describe, expect, it } from "vitest";
import type { Item, Meeting } from "@/lib/types";
import { decisionTrail, findThreads, phrasesOf, signatureOf, standsTemplate, statusText, type ThreadInput } from "./threads";

const now = new Date("2026-11-26T12:00:00.000Z");
const tz = "UTC";
const meeting = (id: string, day: string, title: string): Meeting => ({ id, userId: "u", providerMeetingId: id, title, startedAt: `2026-11-${day}T10:00:00.000Z`, participants: [], processedAt: null });
let n = 0;
const item = (meetingId: string, text: string, o: Partial<Item> = {}): Item => ({
  id: `i${++n}`, userId: "u", kind: "owe", text, person: "Tarun", quote: "", meetingId, dueAt: null, status: "open",
  closedByMeetingId: null, closeQuote: null, createdAt: "2026-11-26T00:00:00.000Z", closedAt: null, ...o,
});

// Five meetings about chart alerts with Tarun and Dilip, three about the earnings tag with only Jit, and noise.
const meetings = [
  meeting("a1", "02", "Chart alerts kickoff"), meeting("a2", "05", "Chart alerts design"), meeting("a3", "09", "Standup"),
  meeting("a4", "12", "Chart alerts backend"), meeting("a5", "20", "Weekly"),
  meeting("e1", "03", "Earnings tag"), meeting("e2", "06", "Earnings tag copy"), meeting("e3", "10", "Earnings tag QA"), meeting("e4", "11", "Earnings tag ship"),
  meeting("x1", "04", "Hiring"), meeting("x2", "07", "Lunch"),
];
const items: Item[] = [
  item("a1", "Write the chart alerts spec", { person: "Tarun" }),
  item("a2", "Share chart alerts designs", { person: "Dilip", status: "done", closedByMeetingId: "a5" }),
  item("a3", "Check chart alerts triggers on RSI", { person: "Dilip" }),
  item("a4", "Hook chart alerts to the push service", { person: "Tarun" }),
  item("a4", "Chart alerts fire once per day", { kind: "decision", person: null }),
  item("a5", "Demo the release to Manku", { person: "Manku" }), // joins through the closure only
  item("e1", "Earnings tag wording", { person: "Jit" }), item("e2", "Earnings tag colours", { person: "Jit" }),
  item("e3", "Earnings tag QA", { person: "Jit" }), item("e4", "Earnings tag rollout", { person: "Jit" }),
  item("x1", "Send the hiring brief", { person: "Aman" }), item("x2", "Book lunch", { person: "Aman" }),
];
const input = (o: Partial<ThreadInput> = {}): ThreadInput => ({ items, meetings, now, timeZone: tz, personOf: (i) => i.person, nameWords: ["Tarun", "Dilip", "Jit"], ...o });

describe("phrases", () => {
  it("pairs non-generic words, stemmed, skipping names", () => {
    expect([...phrasesOf("Share the chart alerts with Tarun's team").keys()]).toEqual(["chart alert"]);
    expect([...phrasesOf("Ask Tarun Kumar about stock splits", new Set(["tarun", "kumar"])).keys()]).toEqual(["stock split"]);
    expect(phrasesOf("Check the option and review the chart").size).toBe(0);
  });
});

describe("finding threads", () => {
  it("clusters meetings by a shared phrase, adds the meeting that closed an item, and names it", () => {
    const [t, ...rest] = findThreads(input());
    expect(rest).toHaveLength(0); // earnings tag has one person; hiring has two meetings
    expect(t.id).toBe("t-chart-alerts");
    expect(t.name).toBe("Chart alerts");
    expect(t.meetings.map((m) => m.id)).toEqual(["a1", "a2", "a3", "a4", "a5"]);
    expect(t.people.map((p) => p.name)).toEqual(["Dilip", "Tarun", "Manku"]);
    expect(t.closures).toHaveLength(1);
    expect(t.open).toHaveLength(4);
    expect(t.decisions).toHaveLength(1);
    expect(t.state).toBe("moving");
  });
  it("needs four meetings and two people", () => {
    expect(findThreads(input({ meetings: meetings.filter((m) => m.id !== "a5" && m.id !== "a4") }))).toHaveLength(0);
    expect(findThreads(input({ personOf: (i) => (i.person ? "Jit" : null) }))).toHaveLength(0);
  });
  it("says Stalled with nothing new for ten days, Wrapped up with nothing open", () => {
    expect(findThreads(input({ now: new Date("2026-12-05T12:00:00.000Z") }))[0].state).toBe("stalled");
    expect(findThreads(input({ items: items.map((i) => (i.kind === "decision" ? i : { ...i, status: "done" as const })) }))[0].state).toBe("wrapped");
  });
  it("leaves out a thread you said isn't one, and one already filed to your project", () => {
    expect(findThreads(input({ dismissed: ["t-chart-alerts"] }))).toHaveLength(0);
    expect(findThreads(input({ items: items.map((i) => (i.meetingId.startsWith("a") ? { ...i, project: "alerts", projectBy: "you" as const } : i)) }))).toHaveLength(0);
  });
  it("never files anything: items come back untouched, with no project set", () => {
    const before = structuredClone(items);
    const threads = findThreads(input());
    expect(items).toEqual(before);
    for (const t of threads) for (const i of t.items) { expect(i.project).toBeUndefined(); expect(i.projectBy).toBeUndefined(); }
  });
  it("changes its signature when an item changes status", () => {
    const a = signatureOf(items);
    expect(signatureOf(items.map((i, k) => (k === 0 ? { ...i, status: "done" as const } : i)))).not.toBe(a);
    expect(signatureOf([...items].reverse())).toBe(a);
  });
});

describe("the decision trail", () => {
  const d = (id: string, at: string): Item => item("a1", `Decision ${id}`, { id, kind: "decision", createdAt: at });
  const saidAt = (i: Item) => i.createdAt;
  const ds = [d("d1", "2026-11-10"), d("d2", "2026-11-11"), d("d3", "2026-11-17"), d("d4", "2026-11-25")];
  it("tags the first call, a change (striking the old one), additions and what stands now", () => {
    const t = decisionTrail(ds, [{ newId: "d2", oldId: "d1" }], saidAt);
    expect(t.map((s) => s.tag.kind)).toEqual(["first", "changes", "adds", "now"]);
    expect(t[0].old).toBe(true);
    expect(t[1].tag).toEqual({ kind: "changes", of: "2026-11-10" });
  });
  it("ignores a change you marked as both standing", () => {
    expect(decisionTrail(ds, [{ newId: "d2", oldId: "d1", status: "kept" }], saidAt)[0].old).toBe(false);
  });
});

describe("words for a thread", () => {
  it("writes where it stands and a copyable status without AI", () => {
    const t = findThreads(input())[0];
    const at = (i: Item) => meetings.find((m) => m.id === i.meetingId)!.startedAt;
    const s = standsTemplate(t, at);
    expect(s).toContain("5 meetings with Dilip, Tarun, Manku.");
    expect(s).toContain("The latest call: Chart alerts fire once per day.");
    const st = statusText(t, s, at, tz);
    expect(st.split("\n")[0]).toBe("Chart alerts: moving");
    expect(st).toContain("• Write the chart alerts spec (Tarun)");
  });
});
