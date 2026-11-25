import { describe, expect, it } from "vitest";
import type { Item, Meeting } from "@/lib/types";
import { belongsTo, findPerson, groupNames, listPeople, normalizeName, personDetail, personSlug } from "./people";

let n = 0;
const meeting = (over: Partial<Meeting> = {}): Meeting => ({
  id: `m${++n}`, userId: "u", providerMeetingId: `p${n}`, title: "Standup", startedAt: "2026-11-20T05:00:00Z", participants: [], processedAt: "x", ...over,
});
const item = (over: Partial<Item> = {}): Item => ({
  id: `i${++n}`, userId: "u", kind: "owe", text: "Do a thing", person: "Nitin", quote: "q", meetingId: "m0", dueAt: null,
  status: "open", closedByMeetingId: null, closeQuote: null, createdAt: "2026-11-20T06:00:00Z", closedAt: null, ...over,
});
const now = new Date("2026-11-25T10:00:00Z");

describe("names", () => {
  it("normalizes and slugs", () => {
    expect(normalizeName("  Nitin   K. ")).toBe("nitin k");
    expect(personSlug("Nitin K.")).toBe("nitin-k");
    expect(personSlug("Zoë O'Neil")).toBe("zoë-o-neil");
  });

  it("merges case and initial variants into one person", () => {
    const g = groupNames(["Nitin", "nitin", "Nitin K", "Nitin", "Priya"]);
    expect(g).toHaveLength(2);
    const nitin = g.find((x) => x.keys.includes("nitin"))!;
    expect(nitin.name).toBe("Nitin");
    expect(nitin.keys).toEqual(["nitin", "nitin k"]);
    expect(nitin.spellings).toEqual(["Nitin", "Nitin K", "nitin"]);
  });

  it("merges an initial with the full surname", () => {
    expect(groupNames(["Nitin K", "Nitin Kumar"])).toHaveLength(1);
  });

  it("keeps different surnames apart, and an ambiguous first name alone", () => {
    const g = groupNames(["Nitin Kumar", "Nitin Rao", "Nitin"]);
    expect(g.map((x) => x.name).sort()).toEqual(["Nitin", "Nitin Kumar", "Nitin Rao"]);
  });

  it("leaves the user out", () => {
    expect(groupNames(["Maruthi", "maru", "Nitin"], ["Maruthi", "Maru"]).map((x) => x.name)).toEqual(["Nitin"]);
  });

  it("matches participants by full name or email", () => {
    const [g] = groupNames(["Nitin K"]);
    expect(belongsTo(g, "Nitin Kumar")).toBe(true);
    expect(belongsTo(g, "nitin.k@acme.com")).toBe(true);
    expect(belongsTo(g, "Nitin Rao")).toBe(false);
    expect(belongsTo(g, null)).toBe(false);
  });
});

describe("listPeople", () => {
  it("counts what you owe, what they owe, overdue, and the last meeting", () => {
    const m1 = meeting({ startedAt: "2026-11-20T05:00:00Z" });
    const m2 = meeting({ startedAt: "2026-11-24T05:00:00Z", participants: ["Nitin Kumar", "Priya"] });
    const items = [
      item({ meetingId: m1.id, person: "Nitin", dueAt: "2026-11-21T00:00:00Z" }),
      item({ meetingId: m1.id, person: "nitin K", kind: "waiting" }),
      item({ meetingId: m1.id, person: "Nitin", status: "done", closedAt: "2026-11-22T00:00:00Z" }),
      item({ meetingId: m1.id, person: "Nitin", status: "wrong" }),
      item({ meetingId: m1.id, person: "Priya", kind: "waiting" }),
    ];
    const people = listPeople({ items, meetings: [m1, m2], now });
    expect(people.map((p) => p.name)).toEqual(["Nitin", "Priya"]);
    expect(people[0]).toMatchObject({ youOwe: 1, theyOwe: 1, overdue: 1, lastMeetingAt: m2.startedAt, meetingCount: 2, slug: "nitin" });
    expect(people[1]).toMatchObject({ youOwe: 0, theyOwe: 1, overdue: 0, lastMeetingAt: m2.startedAt });
  });

  it("ignores people only named on items marked wrong", () => {
    expect(listPeople({ items: [item({ person: "Ghost", status: "wrong" })], meetings: [], now })).toEqual([]);
  });
});

describe("personDetail", () => {
  const m1 = meeting({ title: "Banner review", startedAt: "2026-11-18T05:00:00Z" });
  const m2 = meeting({ title: "Launch sync", startedAt: "2026-11-23T05:00:00Z", participants: ["Nitin"] });
  const m3 = meeting({ title: "Elsewhere", startedAt: "2026-11-24T05:00:00Z", participants: ["Priya"] });
  const items = [
    item({ meetingId: m2.id, text: "Newer owe", person: "Nitin K" }),
    item({ meetingId: m1.id, text: "Older owe", person: "Nitin" }),
    item({ meetingId: m1.id, text: "Get the deck", person: "nitin", kind: "waiting" }),
    item({ meetingId: m1.id, text: "Old close", status: "done", closedAt: "2026-10-01T00:00:00Z", closeQuote: "sent" }),
    item({ meetingId: m1.id, text: "Recent close", status: "done", closedAt: "2026-11-24T00:00:00Z", closeQuote: "done it" }),
    item({ meetingId: m2.id, text: "Ship Friday", kind: "decision", person: null }),
    item({ meetingId: m3.id, text: "Not theirs", kind: "decision", person: null }),
  ];
  const input = { items, meetings: [m1, m2, m3], now };

  it("finds a person by any spelling's slug", () => {
    expect(findPerson("nitin-k", input)?.name).toBe("Nitin");
    expect(findPerson("Nitin", input)?.name).toBe("Nitin");
    expect(findPerson("nobody", input)).toBeNull();
  });

  it("collects open, recently closed, decisions and meetings", () => {
    const d = personDetail("nitin", input)!;
    expect(d.youOwe.map((i) => i.text)).toEqual(["Older owe", "Newer owe"]);
    expect(d.waitingOn.map((i) => i.text)).toEqual(["Get the deck"]);
    expect(d.closed.map((i) => i.text)).toEqual(["Recent close"]);
    expect(d.decisions.map((i) => i.text)).toEqual(["Ship Friday"]);
    expect(d.meetings.map((m) => m.title)).toEqual(["Launch sync", "Banner review"]);
  });
});
