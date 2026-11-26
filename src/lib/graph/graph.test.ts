import { describe, expect, it } from "vitest";
import type { Item, Meeting } from "@/lib/types";
import { resolveItems, resolveMeeting, type Directory, type Person } from "@/lib/directory/directory";
import type { LinkSource } from "@/lib/editor/links";
import { buildGraph, filterGraph, neighborhood, rangeFrom, type GraphData, type GraphInput } from "./graph";

let n = 0;
const now = new Date("2026-11-26T06:00:00Z");
const item = (over: Partial<Item> = {}): Item => ({
  id: `i${++n}`, userId: "u", kind: "owe", text: "Do a thing", person: "Nitin", quote: "I'll do it", meetingId: "m1", dueAt: null,
  status: "open", closedByMeetingId: null, closeQuote: null, createdAt: "2026-11-20T06:00:00Z", closedAt: null, ...over,
});
const meeting = (id: string, over: Partial<Meeting> = {}): Meeting => ({
  id, userId: "u", providerMeetingId: id, title: "Standup", startedAt: "2026-11-20T05:00:00Z", participants: [], processedAt: "x", ...over,
});
const mangku: Person = { id: "p1", name: "Mangku", aliases: ["Mungu", "Munkku"], status: "confirmed", createdAt: "2026-11-01T00:00:00Z" };
const dir: Directory = { people: [mangku], moved: {} };

function input(over: Partial<GraphInput> = {}): GraphInput {
  const meetings = [
    meeting("m1", { title: "Banner review", participants: ["Maruthi", "Nitin Kumar", "Speaker 2", "Munkku"] }),
    meeting("m2", { title: "Offsite", startedAt: "2026-09-01T05:00:00Z", participants: ["Priya"] }),
  ];
  const raw = [
    item({ id: "owe1", text: "Send Nitin the deck", person: "Nitin", dueAt: "2026-11-21T10:00:00Z" }),
    item({ id: "wait1", kind: "waiting", text: "Mungu sends API spec", person: "Mungu" }),
    item({ id: "spk", kind: "waiting", text: "Speaker 5 shares numbers", person: "Speaker 5" }),
    item({ id: "owe2", text: "Review Nitin's copy", person: "Nitin K" }),
    item({ id: "dec1", kind: "decision", text: "Ship the banner Friday", person: null }),
    item({ id: "old", kind: "owe", text: "Book the venue", person: "Priya", meetingId: "m2", status: "done", closedAt: "2026-09-10T00:00:00Z", createdAt: "2026-09-01T06:00:00Z" }),
    item({ id: "wrong", text: "Nonsense", person: "Priya", status: "wrong" }),
  ];
  const sources: LinkSource[] = [
    { type: "note", id: "q4-plan", title: "Q4 plan", markdown: "# Q4 plan\n\nAsk [[person:Munkku|Mangku]] about [[item:owe1|the deck]], see [[Launch notes]] and [[Speaker 3]].\n`[[person:Ghost]]` in code" },
    { type: "note", id: "launch-notes", title: "Launch notes", markdown: "# Launch notes\n\nBack to [[note:q4-plan]] and [[day:2026-11-20]]. Also [[person:Leela]]." },
    { type: "day", id: "2026-11-25", title: "2026-11-25", markdown: "Met [[Nitin]] today, [[meeting:m1|Banner review]]." },
  ];
  return {
    items: resolveItems(raw, dir),
    meetings: meetings.map((m) => resolveMeeting(m, dir)),
    people: dir.people,
    self: ["Maruthi", "Maru"],
    sources,
    notes: [
      { slug: "q4-plan", title: "Q4 plan", updatedAt: "2026-11-24T00:00:00Z" },
      { slug: "launch-notes", title: "Launch notes", updatedAt: "2026-11-23T00:00:00Z" },
      { slug: "orphan", title: "Orphan", updatedAt: "2026-11-22T00:00:00Z" },
    ],
    now,
    timeZone: "Asia/Kolkata",
    ...over,
  };
}

const ids = (g: GraphData) => g.nodes.map((x) => x.id).sort();
const has = (g: GraphData, s: string, t: string, type?: string) => g.edges.some((e) => ((e.source === s && e.target === t) || (e.source === t && e.target === s)) && (!type || e.type === type));

describe("buildGraph", () => {
  const g = buildGraph(input());

  it("makes people, meetings, promises, decisions and notes", () => {
    const byType = (t: string) => g.nodes.filter((x) => x.type === t).map((x) => x.id).sort();
    expect(byType("person")).toEqual(["person:leela", "person:mangku", "person:nitin-k", "person:priya"]);
    expect(byType("meeting")).toEqual(["meeting:m1", "meeting:m2"]);
    expect(byType("promise")).toEqual(["item:old", "item:owe1", "item:owe2", "item:spk", "item:wait1"]);
    expect(byType("decision")).toEqual(["item:dec1"]);
    expect(byType("note")).toEqual(["day:2026-11-20", "day:2026-11-25", "note:launch-notes", "note:orphan", "note:q4-plan"]);
    expect(g.nodes.find((x) => x.id === "item:wrong")).toBeUndefined();
  });

  it("names people through the directory and never makes a node for a speaker label or for you", () => {
    expect(g.nodes.find((x) => x.id === "person:mangku")?.label).toBe("Mangku");
    expect(g.nodes.some((x) => /speaker/i.test(x.id) || /speaker/i.test(x.type === "person" ? x.label : ""))).toBe(false);
    expect(g.nodes.some((x) => x.id === "person:maruthi" || x.id === "person:maru")).toBe(false);
    // The unlabelled item is there, but tied to nobody.
    expect(g.edges.filter((e) => e.source === "item:spk" && e.type !== "from")).toEqual([]);
    expect(g.nodes.find((x) => x.id === "item:spk")?.label).not.toMatch(/Speaker 5/);
  });

  it("links who owes whom, where each item came from and who was in a meeting", () => {
    expect(g.edges).toContainEqual({ source: "item:owe1", target: "person:nitin-k", type: "owes" });
    expect(g.edges).toContainEqual({ source: "item:wait1", target: "person:mangku", type: "owed" });
    expect(g.edges).toContainEqual({ source: "item:owe1", target: "meeting:m1", type: "from" });
    expect(g.edges).toContainEqual({ source: "item:dec1", target: "meeting:m1", type: "from" });
    expect(has(g, "person:nitin-k", "meeting:m1", "met")).toBe(true); // "Nitin Kumar" is Nitin K, who is Nitin
    expect(has(g, "person:mangku", "meeting:m1", "met")).toBe(true); // "Munkku" is an alias
  });

  it("turns [[links]] into edges, both ways round for backlinks, skipping code and speaker labels", () => {
    expect(g.edges).toContainEqual({ source: "note:q4-plan", target: "person:mangku", type: "link" });
    expect(g.edges).toContainEqual({ source: "note:q4-plan", target: "item:owe1", type: "link" });
    expect(g.edges).toContainEqual({ source: "note:q4-plan", target: "note:launch-notes", type: "link" });
    expect(g.edges).toContainEqual({ source: "note:launch-notes", target: "note:q4-plan", type: "link" });
    expect(g.edges).toContainEqual({ source: "note:launch-notes", target: "day:2026-11-20", type: "link" });
    expect(g.edges).toContainEqual({ source: "day:2026-11-25", target: "person:nitin-k", type: "link" });
    expect(g.edges).toContainEqual({ source: "day:2026-11-25", target: "meeting:m1", type: "link" });
    expect(ids(g)).not.toContain("person:ghost");
    expect(ids(g)).not.toContain("person:speaker-3");
    // A linked name nobody has yet still opens their page.
    expect(g.nodes.find((x) => x.id === "person:leela")?.href).toBe("/people/leela");
  });

  it("marks open, late and done, with a preview line", () => {
    const owe = g.nodes.find((x) => x.id === "item:owe1")!;
    expect(owe).toMatchObject({ open: true, overdue: true, kind: "owe", href: "/item/owe1" });
    expect(owe.sub).toContain("You owe Nitin");
    expect(owe.detail).toContain("I'll do it");
    expect(g.nodes.find((x) => x.id === "item:old")).toMatchObject({ open: false });
    expect(g.nodes.find((x) => x.id === "meeting:m1")?.sub).toMatch(/20 Nov · Nitin Kumar, Mangku$/);
  });

  it("leaves out meetings recorded twice", () => {
    const g2 = buildGraph(input({ meetings: [meeting("m1"), meeting("m3", { duplicateOf: "m1" })] }));
    expect(ids(g2)).not.toContain("meeting:m3");
  });
});

describe("filterGraph", () => {
  const g = buildGraph(input());

  it("filters by type", () => {
    const f = filterGraph(g, { types: ["person", "promise"] });
    expect(new Set(f.nodes.map((x) => x.type))).toEqual(new Set(["person", "promise"]));
    expect(f.edges.every((e) => f.nodes.some((x) => x.id === e.source) && f.nodes.some((x) => x.id === e.target))).toBe(true);
  });

  it("open only drops done items, and meetings and people left with nothing", () => {
    const f = filterGraph(g, { openOnly: true });
    expect(ids(f)).not.toContain("item:old");
    expect(ids(f)).not.toContain("meeting:m2");
    expect(ids(f)).not.toContain("person:priya");
    expect(ids(f)).toContain("item:owe1");
    expect(ids(f)).toContain("note:orphan"); // notes stay
  });

  it("by person keeps what is within two steps", () => {
    const f = filterGraph(g, { person: "person:mangku" });
    expect(ids(f)).toEqual(expect.arrayContaining(["person:mangku", "item:wait1", "note:q4-plan", "meeting:m1", "item:owe1"]));
    expect(ids(f)).not.toContain("meeting:m2");
    expect(ids(f)).not.toContain("note:orphan");
  });

  it("by time range", () => {
    const f = filterGraph(g, { from: rangeFrom("30d", now) });
    expect(ids(f)).not.toContain("meeting:m2");
    expect(ids(f)).not.toContain("item:old");
    expect(ids(f)).toContain("meeting:m1");
    expect(rangeFrom("all", now)).toBeNull();
  });
});

describe("neighborhood", () => {
  const g = buildGraph(input());
  it("one and two hops from a node, centre first", () => {
    const one = neighborhood(g, "note:launch-notes", 1);
    expect(ids(one)).toEqual(["day:2026-11-20", "note:launch-notes", "note:q4-plan", "person:leela"].sort());
    const two = neighborhood(g, "note:launch-notes", 2);
    expect(ids(two)).toEqual(expect.arrayContaining(["person:mangku", "item:owe1"]));
    expect(neighborhood(g, "nope", 2).nodes).toEqual([]);
    expect(neighborhood(g, "meeting:m1", 2, 5).nodes.length).toBe(5);
    expect(neighborhood(g, "meeting:m1", 2, 5).nodes[0].id).toBe("meeting:m1");
  });
});

describe("scale", () => {
  it("builds and filters a 500-node graph quickly", () => {
    const people = Array.from({ length: 60 }, (_, k) => `Person ${String.fromCharCode(65 + (k % 26))}${Math.floor(k / 26)}x`);
    const meetings = Array.from({ length: 120 }, (_, k) => meeting(`mm${k}`, { title: `Meeting ${k}`, startedAt: new Date(now.getTime() - k * 86400000).toISOString(), participants: [people[k % 60], people[(k * 7) % 60]] }));
    const items = Array.from({ length: 320 }, (_, k) => item({ id: `x${k}`, kind: k % 5 === 0 ? "decision" : k % 2 ? "owe" : "waiting", person: k % 5 === 0 ? null : people[k % 60], meetingId: `mm${k % 120}`, status: k % 4 === 0 ? "done" : "open" }));
    const t0 = performance.now();
    const g = buildGraph(input({ items, meetings, people: [], sources: [], notes: [] }));
    const f = filterGraph(g, { openOnly: true });
    expect(g.nodes.length).toBeGreaterThanOrEqual(480);
    expect(f.nodes.length).toBeLessThan(g.nodes.length);
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});
