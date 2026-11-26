import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Item, Meeting } from "@/lib/types";
import { buildUserMessage } from "@/lib/extract/prompt";
import { findPerson, groupNames, listPeople, personDetail } from "@/lib/people";
import { MemoryStore } from "@/server/store";
import { FileStore } from "@/server/local/file-store";
import { processMeeting } from "@/server/jobs/process";
import {
  applyOps, confirmMany, confirmNew, editPerson, emptyDirectory, ignoreNames, knownPeople, merge, moveItems, resolveItems, resolver, undoOps,
  type ChangeCtx, type Directory, type PeopleChange,
} from "./directory";
import { keySimilarity, soundKey } from "./phonetic";
import { namesToCheck, rankMatches } from "./review";

let n = 0;
const ctx = (): ChangeCtx => ({ newId: () => `id${++n}`, at: "2026-11-26T00:00:00Z" });
const item = (over: Partial<Item> = {}): Item => ({
  id: `i${++n}`, userId: "u", kind: "owe", text: "Do a thing", person: "Nitin", quote: "q", meetingId: "m1", dueAt: null,
  status: "open", closedByMeetingId: null, closeQuote: null, createdAt: "2026-11-20T06:00:00Z", closedAt: null, ...over,
});
const meeting = (over: Partial<Meeting> = {}): Meeting => ({
  id: `m${++n}`, userId: "u", providerMeetingId: `p${n}`, title: "Standup", startedAt: "2026-11-20T05:00:00Z", participants: [], processedAt: "x", ...over,
});
function apply(d: Directory, c: PeopleChange | null): PeopleChange {
  expect(c).not.toBeNull();
  applyOps(d, c!.ops);
  return c!;
}

describe("sound keys", () => {
  it("folds the spellings transcription gives one name", () => {
    expect(new Set(["Mangku", "Mungu", "Manku", "Munkku"].map(soundKey)).size).toBe(1);
    expect(soundKey("Nithin")).toBe(soundKey("Nitin"));
    expect(soundKey("Jeetendar")).toBe(soundKey("Jitender"));
    expect(soundKey("Nandani")).toBe(soundKey("Nandini"));
    expect(keySimilarity(soundKey("Anirudhan"), soundKey("Anirudh"))).toBeGreaterThanOrEqual(0.85);
    expect(soundKey("Priya")).not.toBe(soundKey("Prithwal"));
    expect(soundKey("Nandani")).not.toBe(soundKey("Nitin"));
  });
});

describe("suggestions", () => {
  const known = ["Mangku", "Jitender", "Nitin", "Anirudh", "Nandini", "Manish", "Priya", "Arjun", "Nitin Rao"];
  const cands = known.map((name, k) => ({ name, personId: `p${k}`, spellings: [name], meetingIds: new Set<string>() }));
  const top = (name: string) => rankMatches(name, new Set(), cands)[0]?.name;

  it.each([
    ["Munkku", "Mangku"], ["Mungu", "Mangku"], ["Jeetendar", "Jitender"], ["Nithin", "Nitin"],
    ["Anirudhan", "Anirudh"], ["Nandani", "Nandini"],
  ])("%s -> %s", (raw, want) => expect(top(raw)).toBe(want));

  it("suggests nothing for a name that sounds like nobody", () => {
    expect(rankMatches("Prithwal", new Set(), cands)).toEqual([]);
  });

  it("ranks a shared meeting higher, and says why", () => {
    const two = [
      { name: "Nitin Kumar", personId: "a", spellings: ["Nitin Kumar"], meetingIds: new Set<string>() },
      { name: "Nitin Rao", personId: "b", spellings: ["Nitin Rao"], meetingIds: new Set(["m1", "m2"]) },
    ];
    const r = rankMatches("Nithin", new Set(["m1", "m2"]), two);
    expect(r[0].name).toBe("Nitin Rao");
    expect(r[0].why).toContain("in 2 of the same meetings");
    expect(r[0].why).toContain("sounds alike");
  });

  it("doesn't call Nandani a Nitin", () => {
    expect(rankMatches("Nandani", new Set(), cands.filter((c) => c.name !== "Nandini"))).toEqual([]);
  });

  it("never offers a smaller unchecked name as the target", () => {
    expect(rankMatches("Mangku", new Set(), [{ name: "Munkku", spellings: ["Munkku"], meetingIds: new Set(), weight: 1 }], 5)).toEqual([]);
  });

  it("lists unchecked names with where they appear and the best matches", () => {
    const m1 = meeting({ title: "Ops sync", participants: ["Mangku"] });
    const d = emptyDirectory();
    apply(d, confirmNew(d, { name: "Mangku", spellings: ["Mangku"] }, ctx()));
    const items = resolveItems([
      item({ person: "Mangku", meetingId: m1.id }),
      item({ person: "Munkku", meetingId: m1.id, quote: "Munkku will send the sheet", createdAt: "2026-11-21T00:00:00Z" }),
      item({ person: "Munkku", meetingId: m1.id, status: "wrong" }),
      item({ person: "Maruthi", meetingId: m1.id }),
    ], d);
    const list = namesToCheck({ items, meetings: [m1], people: d.people, self: ["Maruthi"] });
    expect(list.map((x) => x.name)).toEqual(["Munkku"]);
    expect(list[0]).toMatchObject({ items: 1, meetings: 1, quote: { text: "Munkku will send the sheet", meeting: "Ops sync" } });
    expect(list[0].suggestions[0]).toMatchObject({ name: "Mangku", personId: d.people[0].id });
  });
});

describe("resolution", () => {
  it("shows the confirmed name, keeps the raw one, hides ignored names", () => {
    const d = emptyDirectory();
    apply(d, confirmNew(d, { name: "Mangku", spellings: ["Mangku", "Mungu"], email: "mangku@acme.com" }, ctx()));
    apply(d, ignoreNames(d, ["Speaker Two"], ctx()));
    const [a, b, c] = resolveItems([item({ person: "mungu" }), item({ person: "Speaker two" }), item({ person: "Priya" })], d);
    expect(a).toMatchObject({ person: "Mangku", personRaw: "mungu", personId: d.people[0].id });
    expect(b).toMatchObject({ person: null, personRaw: "Speaker two" });
    expect(c.person).toBe("Priya");
    expect(c.personId).toBeUndefined();
    const r = resolver(d);
    expect(r.participant("mangku@acme.com")).toBe("Mangku");
    expect(r.participant("Manku")).toBe("Manku");
  });

  it("returns the same items without a directory", () => {
    const items = [item()];
    expect(resolveItems(items, emptyDirectory())).toBe(items);
    expect(resolveItems(items, undefined)).toBe(items);
  });

  it("groups People by the directory and never merges confirmed people by guess", () => {
    const d = emptyDirectory();
    apply(d, confirmNew(d, { name: "Nitin", spellings: ["Nitin", "Nithin"] }, ctx()));
    apply(d, confirmNew(d, { name: "Nitin Rao", spellings: ["Nitin Rao"] }, ctx()));
    const items = resolveItems([item({ person: "Nithin" }), item({ person: "Nitin Rao", kind: "waiting" }), item({ person: "Jeetendar" })], d);
    const people = listPeople({ items, meetings: [], now: new Date("2026-11-25T00:00:00Z"), people: d.people });
    expect(people.map((p) => [p.name, p.youOwe + p.theyOwe, p.confirmed])).toEqual([["Jeetendar", 1, false], ["Nitin", 1, true], ["Nitin Rao", 1, true]]);
    expect(findPerson("nithin", { items, meetings: [], now: new Date(), people: d.people })?.name).toBe("Nitin");
  });
});

describe("changes and undo", () => {
  it("merges a name into a person as an alias, and undoes it", () => {
    const d = emptyDirectory();
    apply(d, confirmNew(d, { name: "Mangku", spellings: ["Mangku"] }, ctx()));
    const c = apply(d, merge(d, { name: "Munkku", spellings: ["Munkku", "munkku"] }, { personId: d.people[0].id }, ctx()));
    expect(c.label).toBe("Munkku is Mangku");
    expect(d.people[0].aliases).toEqual(["Munkku"]);
    applyOps(d, undoOps(d, c));
    expect(d.people[0].aliases).toEqual([]);
  });

  it("merges one person into another, moved items follow, and undo brings it back", () => {
    const d = emptyDirectory();
    apply(d, confirmNew(d, { name: "Jitender", spellings: ["Jitender"] }, ctx()));
    apply(d, confirmNew(d, { name: "Jeetendar", spellings: ["Jeetendar", "Jeetu"], email: "j@x.com" }, ctx()));
    const [jit, jee] = d.people;
    apply(d, moveItems(d, ["i-a"], { personId: jee.id }, ctx()));
    const c = apply(d, merge(d, { personId: jee.id }, { personId: jit.id }, ctx()));
    expect(d.people).toHaveLength(1);
    expect(d.people[0]).toMatchObject({ name: "Jitender", aliases: ["Jeetendar", "Jeetu"], email: "j@x.com" });
    expect(d.moved["i-a"]).toBe(jit.id);
    applyOps(d, undoOps(d, c));
    expect(d.people.map((p) => p.name).sort()).toEqual(["Jeetendar", "Jitender"]);
    expect(d.people.find((p) => p.id === jit.id)).toMatchObject({ aliases: [], email: undefined });
    expect(d.moved["i-a"]).toBe(jee.id);
  });

  it("undoes one change and keeps a later one", () => {
    const d = emptyDirectory();
    apply(d, confirmNew(d, { name: "Mangku", spellings: ["Mangku"] }, ctx()));
    const first = apply(d, merge(d, { name: "Mungu" }, { personId: d.people[0].id }, ctx()));
    apply(d, merge(d, { name: "Manku" }, { personId: d.people[0].id }, ctx()));
    applyOps(d, undoOps(d, first));
    expect(d.people[0].aliases).toEqual(["Manku"]);
  });

  it("renames to an existing person as a merge, and takes a spelling off its old owner", () => {
    const d = emptyDirectory();
    apply(d, confirmNew(d, { name: "Nitin", spellings: ["Nitin", "Nithin"] }, ctx()));
    apply(d, confirmNew(d, { name: "Nithin Rao", spellings: ["Nithin Rao"] }, ctx()));
    // "Nithin" was really Nithin Rao
    apply(d, merge(d, { name: "Nithin" }, { personId: d.people[1].id }, ctx()));
    expect(d.people[0].aliases).toEqual([]);
    expect(d.people[1].aliases).toEqual(["Nithin"]);
    const c = apply(d, confirmNew(d, { name: "nitin", spellings: ["Nitn"] }, ctx()));
    expect(c.label).toBe("Nitn is Nitin");
  });

  it("splits items to another person and edits a person, keeping the old name as an alias", () => {
    const d = emptyDirectory();
    apply(d, confirmNew(d, { name: "Nitin", spellings: ["Nitin"] }, ctx()));
    const c = apply(d, moveItems(d, ["i1", "i2"], { name: "Nitin Rao" }, ctx()));
    expect(c.label).toBe("2 items moved to Nitin Rao");
    const rao = d.people.find((p) => p.name === "Nitin Rao")!;
    expect(resolveItems([item({ id: "i1", person: "Nitin" })], d)[0].person).toBe("Nitin Rao");
    apply(d, editPerson(d, rao.id, { name: "Nitin R", email: "nr@x.com" }, ctx()));
    expect(d.people.find((p) => p.id === rao.id)).toMatchObject({ name: "Nitin R", aliases: ["Nitin Rao"], email: "nr@x.com" });
    applyOps(d, undoOps(d, c));
    expect(d.moved).toEqual({});
  });
});

describe("store", () => {
  it("resolves items and meetings on read, keeps raw names stored, and logs undoable changes", async () => {
    const s = new MemoryStore();
    const u = s.addUser({ email: "a@b" });
    const { meeting: m } = await s.upsertMeeting({ userId: u.id, providerMeetingId: "p", title: "Sync", startedAt: "2026-11-20T05:00:00Z", participants: ["Mungu"] });
    await s.commitExtraction({ meetingId: m.id, userId: u.id, newItems: [{ kind: "owe", text: "Send sheet", person: "Mungu", quote: "q", meetingId: m.id, dueAt: null }], closes: [], at: "2026-11-20T06:00:00Z" });
    const c = await s.changePeople(u.id, (d, x) => confirmNew(d, { name: "Mangku", spellings: ["Mungu"] }, x), "2026-11-26T00:00:00Z");
    expect((await s.listItems(u.id))[0]).toMatchObject({ person: "Mangku", personRaw: "Mungu" });
    expect([...s.items.values()][0].person).toBe("Mungu");
    expect((await s.getMeeting(m.id))!.participants).toEqual(["Mangku"]);
    expect((await s.listPeopleChanges(u.id)).map((x) => x.label)).toEqual(["Mungu renamed to Mangku"]);
    await s.undoPeopleChange(u.id, c!.id);
    expect((await s.listItems(u.id))[0].person).toBe("Mungu");
    expect(await s.undoPeopleChange(u.id, c!.id)).toBeNull();
  });

  it("FileStore saves the directory, and loads an older file without one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "names-"));
    const path = join(dir, "state.json");
    writeFileSync(path, JSON.stringify({ version: 1, users: [{ id: "u", email: "a@b", name: "Me", aliases: [], timeZone: "Asia/Kolkata", briefTime: "18:00", createdAt: "x" }], connections: [], meetings: [], items: [item({ userId: "u", person: "Nithin" })], briefs: [] }));
    const fs1 = new FileStore(path);
    expect((await fs1.getPeople("u")).people).toEqual([]);
    expect((await fs1.listItems("u"))[0].person).toBe("Nithin");
    await fs1.changePeople("u", (d, x) => confirmNew(d, { name: "Nitin", spellings: ["Nithin"] }, x), "2026-11-26T00:00:00Z");
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved.items[0].person).toBe("Nithin");
    expect(saved.items[0].personRaw).toBeUndefined();
    const fs2 = new FileStore(path);
    expect((await fs2.listItems("u"))[0]).toMatchObject({ person: "Nitin", personRaw: "Nithin" });
    expect(await fs2.listPeopleChanges("u")).toHaveLength(1);
  });
});

describe("extraction", () => {
  it("puts confirmed people with their spellings in the prompt", () => {
    const d = emptyDirectory();
    apply(d, confirmNew(d, { name: "Mangku", spellings: ["Mungu", "Manku"] }, ctx()));
    apply(d, confirmNew(d, { name: "Nitin", spellings: ["Nitin"] }, ctx()));
    apply(d, ignoreNames(d, ["Speaker"], ctx()));
    const known = knownPeople(d);
    expect(known).toEqual([{ name: "Mangku", aliases: ["Mungu", "Manku"] }, { name: "Nitin", aliases: [] }]);
    const msg = buildUserMessage({
      transcript: "t", user: { name: "Me", aliases: [], timeZone: "Asia/Kolkata" },
      meeting: { title: "Sync", startedAt: "2026-11-20T05:00:00Z", participants: [] }, openItems: [], knownPeople: known,
    });
    expect(msg).toContain("Known people: Mangku (also Mungu, Manku); Nitin\n");
    const without = buildUserMessage({ transcript: "t", user: { name: "Me", aliases: [], timeZone: "Asia/Kolkata" }, meeting: { title: "Sync", startedAt: "2026-11-20T05:00:00Z", participants: [] }, openItems: [] });
    expect(without).not.toContain("Known people");
  });

  it("passes known people to the extractor and new items resolve through their aliases", async () => {
    const s = new MemoryStore();
    const u = s.addUser({ email: "a@b", name: "Me" });
    await s.saveConnection({ userId: u.id, provider: "wispr_flow", accessToken: "a", refreshToken: "r", expiresAt: "2099", lastSeenAt: null, status: "active" });
    const { meeting: m } = await s.upsertMeeting({ userId: u.id, providerMeetingId: "p", title: "Sync", startedAt: "2026-11-20T05:00:00Z", participants: [] });
    await s.changePeople(u.id, (d, x) => confirmNew(d, { name: "Mangku", spellings: ["Mungu"] }, x), "2026-11-19T00:00:00Z");
    let seen: unknown;
    await processMeeting({
      store: s, model: "m", now: () => new Date("2026-11-20T07:00:00Z"), costInr: () => 0,
      wispr: () => ({ getTranscript: async () => "Mungu: I'll send it" }) as never,
      extract: async (input) => { seen = input.knownPeople; return { newItems: [{ kind: "waiting", text: "Send it", person: "Mungu", quote: "I'll send it", dueAt: null }], closes: [], usage: { inputTokens: 1, outputTokens: 1 } }; },
    }, m.id);
    expect(seen).toEqual([{ name: "Mangku", aliases: ["Mungu"] }]);
    expect((await s.listItems(u.id))[0]).toMatchObject({ person: "Mangku", personRaw: "Mungu" });
  });
});

describe("bulk confirm", () => {
  it("confirms names without look-alikes in one undoable change", () => {
    const d = emptyDirectory();
    apply(d, confirmNew(d, { name: "Priya", spellings: ["Priya"] }, ctx()));
    const c = apply(d, confirmMany(d, [{ name: "Arjun", spellings: ["Arjun", "arjun"] }, { name: "Leela", spellings: ["Leela"] }, { name: "Priya", spellings: ["Priya"] }], ctx()));
    expect(c.label).toBe("2 names confirmed as they are");
    expect(d.people.map((p) => p.name)).toEqual(["Priya", "Arjun", "Leela"]);
    applyOps(d, undoOps(d, c));
    expect(d.people.map((p) => p.name)).toEqual(["Priya"]);
  });
});

describe("MCP", () => {
  it("finds a person by an alias and shows the confirmed name", async () => {
    const { person } = await import("@/mcp/tools");
    const s = new MemoryStore();
    const u = s.addUser({ email: "a@b", name: "Me" });
    const { meeting: m } = await s.upsertMeeting({ userId: u.id, providerMeetingId: "p", title: "Sync", startedAt: "2026-11-20T05:00:00Z", participants: [] });
    await s.commitExtraction({ meetingId: m.id, userId: u.id, newItems: [{ kind: "owe", text: "Send sheet", person: "Munkku", quote: "q", meetingId: m.id, dueAt: null }], closes: [], at: "2026-11-20T06:00:00Z" });
    await s.changePeople(u.id, (d, x) => confirmNew(d, { name: "Mangku", spellings: ["Munkku", "Mungu"] }, x), "2026-11-26T00:00:00Z");
    const out = await person({ store: s, now: () => new Date("2026-11-25T00:00:00Z") }, { name: "mungu" });
    expect(out).toContain("# Mangku");
    expect(out).toContain("Send sheet");
  });
});

describe("workspaces", () => {
  it("keeps one directory per workspace state file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "names-ws-"));
    const state = (name: string) => {
      const p = join(dir, `${name}.json`);
      writeFileSync(p, JSON.stringify({ version: 1, users: [{ id: "u", email: "a@b", name: "Me", aliases: [], timeZone: "Asia/Kolkata", briefTime: "18:00", createdAt: "x" }], connections: [], meetings: [], items: [item({ userId: "u", person: "Nithin" })], briefs: [] }));
      return p;
    };
    const work = new FileStore(state("work")), home = new FileStore(state("home"));
    await work.changePeople("u", (d, x) => confirmNew(d, { name: "Nitin", spellings: ["Nithin"] }, x), "2026-11-26T00:00:00Z");
    expect((await work.listItems("u"))[0].person).toBe("Nitin");
    expect((await home.listItems("u"))[0].person).toBe("Nithin");
    expect((await home.getPeople("u")).people).toEqual([]);
  });
});

describe("widget", () => {
  it("counts the same with a directory (names resolved, ignored names kept as items)", async () => {
    const { widgetSummary } = await import("@/lib/platform/widget");
    const s = new MemoryStore();
    const u = s.addUser({ email: "a@b", name: "Me" });
    const { meeting: m } = await s.upsertMeeting({ userId: u.id, providerMeetingId: "p", title: "Sync", startedAt: "2026-11-25T05:00:00Z", participants: [] });
    await s.commitExtraction({ meetingId: m.id, userId: u.id, at: "2026-11-25T06:00:00Z", closes: [], newItems: [
      { kind: "owe", text: "Send sheet", person: "Mungu", quote: "q", meetingId: m.id, dueAt: null },
      { kind: "owe", text: "Send recap", person: "Speaker 2", quote: "q2", meetingId: m.id, dueAt: null },
    ] });
    const now = new Date("2026-11-25T08:00:00Z");
    const before = await widgetSummary(s, u, now);
    await s.changePeople(u.id, (d, x) => confirmNew(d, { name: "Mangku", spellings: ["Mungu"] }, x), "2026-11-25T07:00:00Z");
    await s.changePeople(u.id, (d, x) => ignoreNames(d, ["Speaker 2"], x), "2026-11-25T07:00:00Z");
    const after = await widgetSummary(s, u, now);
    expect({ ...after, updatedAt: "" }).toEqual({ ...before, updatedAt: "" });
    expect(after.owe).toBe(2);
  });
});

describe("speaker labels", () => {
  it("recognises generic labels, case-insensitive, and not real names", async () => {
    const { isSpeakerLabel } = await import("./speakers");
    for (const s of ["Speaker 5", "speaker A", "SPEAKER_2", "Unknown", "Unknown Speaker", "Participant 3", "participant", "Guest", "Guest 2", "S1", "Speaker #4", "Unidentified speaker"]) expect(isSpeakerLabel(s), s).toBe(true);
    for (const s of ["Nitin", "Mangku", "Sujay", "Guestin", "Speakman", "Sp", "Priya Speaker", null, ""]) expect(isSpeakerLabel(s), String(s)).toBe(false);
  });

  it("shows items unattributed without rewriting stored names, with or without a directory", async () => {
    const { unlabelledSpeakers } = await import("./review");
    const raw = [item({ person: "Speaker 5", text: "Send Speaker 5 the deck" }), item({ person: "speaker_5", kind: "waiting", text: "Get the numbers" }), item({ person: "Nitin" })];
    for (const d of [emptyDirectory(), (() => { const x = emptyDirectory(); apply(x, confirmNew(x, { name: "Nitin", spellings: ["Nitin"] }, ctx())); return x; })()]) {
      const items = resolveItems(raw, d);
      expect(items[0]).toMatchObject({ person: null, personRaw: "Speaker 5", unattributed: true, text: "Send someone (unlabelled speaker) the deck" });
      expect(items[1]).toMatchObject({ person: null, unattributed: true });
      expect(raw[0].person).toBe("Speaker 5");
      expect(listPeople({ items, meetings: [], now: new Date("2026-11-25T00:00:00Z"), people: d.people }).map((p) => p.name)).toEqual(["Nitin"]);
      expect(namesToCheck({ items, meetings: [], people: d.people }).map((n) => n.name)).toEqual(d.people.length ? [] : ["Nitin"]);
      expect(unlabelledSpeakers(items)).toEqual([{ label: "Speaker 5", items: 2 }]);
    }
  });

  it("a split still assigns a speaker-labelled item to a real person", () => {
    const d = emptyDirectory();
    apply(d, moveItems(d, ["sp1"], { name: "Ravi" }, ctx()));
    expect(resolveItems([item({ id: "sp1", person: "Speaker 3" })], d)[0]).toMatchObject({ person: "Ravi" });
  });

  it("keeps speaker labels out of grouping (participants, prep)", () => {
    expect(groupNames(["Speaker 1", "Nitin", "Guest"]).map((g) => g.name)).toEqual(["Nitin"]);
  });
});

describe("note links", () => {
  it("[[person:alias]] backlinks reach the confirmed person only; speaker labels reach nobody", async () => {
    const { linkIsPerson } = await import("./match");
    const d = emptyDirectory();
    apply(d, confirmNew(d, { name: "Mangku", spellings: ["Mungu", "Manku"] }, ctx()));
    apply(d, confirmNew(d, { name: "Nitin Kumar", spellings: ["Nitin Kumar"] }, ctx()));
    const [mangku, nitinKumar, nitinK] = groupNames(["Nitin K"], [], d.people).sort((a, b) => (a.personId ?? "z").localeCompare(b.personId ?? "z"));
    expect(mangku.name).toBe("Mangku");
    expect(linkIsPerson(mangku, "Mungu", d.people)).toBe(true);
    expect(linkIsPerson(mangku, "manku", d.people)).toBe(true);
    // a confirmed full name isn't claimed by an unchecked look-alike group
    expect(nitinK.name).toBe("Nitin K");
    expect(linkIsPerson(nitinK, "Nitin Kumar", d.people)).toBe(false);
    expect(linkIsPerson(nitinKumar, "Nitin Kumar", d.people)).toBe(true);
    expect(linkIsPerson(nitinK, "Speaker 5", d.people)).toBe(false);
  });
});

describe("calendar and grouping through the directory", () => {
  it("resolves calendar attendees on read and never writes them back", async () => {
    const s = new MemoryStore();
    const u = s.addUser({ email: "a@b", name: "Me" });
    const cache = { fetchedAt: "2026-11-25T00:00:00Z", nextFetchAt: "2026-11-25T00:30:00Z", fromIso: "a", toIso: "z", seriesChecked: {}, series: [],
      events: [{ calendarId: "c1", title: "1:1", startsAt: "2026-11-26T05:00:00Z", endsAt: null, attendees: ["Mungu", "mangku@acme.com"] }] };
    await s.saveCalendar(u.id, cache);
    await s.changePeople(u.id, (d, x) => confirmNew(d, { name: "Mangku", spellings: ["Mungu"], email: "mangku@acme.com" }, x), "2026-11-25T00:00:00Z");
    expect((await s.getCalendar(u.id))!.events[0].attendees).toEqual(["Mangku"]);
    expect((await s.getCalendarRaw(u.id))!.events[0].attendees).toEqual(["Mungu", "mangku@acme.com"]);
    expect(s.calendar.get(u.id)!.events[0].attendees).toEqual(["Mungu", "mangku@acme.com"]);
  });

  it("prep never merges two confirmed people who share a first name", async () => {
    const { prepFor } = await import("@/lib/wow/prep");
    const d = emptyDirectory();
    apply(d, confirmNew(d, { name: "Nitin", spellings: ["Nitin"] }, ctx()));
    apply(d, confirmNew(d, { name: "Nitin Kumar", spellings: ["Nitin Kumar"] }, ctx()));
    const items = resolveItems([item({ person: "Nitin", text: "A" }), item({ person: "Nitin Kumar", text: "B" })], d);
    const meeting = { calendarId: "c", title: "1:1", startsAt: "2026-11-26T05:00:00Z", attendees: ["Nitin Kumar"] };
    expect(prepFor(meeting, items, [], d.people).owe.map((i) => i.text)).toEqual(["B"]);
    // without a directory, today's guess stays: "Nitin" joins the only "Nitin ..." in the room
    expect(prepFor(meeting, [item({ person: "Nitin", text: "A" }), item({ person: "Nitin Kumar", text: "B" })], []).owe.map((i) => i.text).sort()).toEqual(["A", "B"]);
  });

  it("items are the same person by directory id, else by guess", async () => {
    const { itemsSamePerson } = await import("@/lib/people");
    const guess = (a: string | null, b: string | null) => !!a && !!b && a.split(" ")[0] === b.split(" ")[0];
    expect(itemsSamePerson({ person: "Nitin", personId: "a" }, { person: "Nitin Kumar", personId: "b" }, guess)).toBe(false);
    expect(itemsSamePerson({ person: "Nitin", personId: "a" }, { person: "Nitin", personId: "a" }, guess)).toBe(true);
    expect(itemsSamePerson({ person: "Nitin", personId: "a" }, { person: "Nitin K" }, guess)).toBe(false);
    expect(itemsSamePerson({ person: "Nitin" }, { person: "Nitin K" }, guess)).toBe(true);
  });

  it("the week view counts confirmed people apart", async () => {
    const { buildWeek } = await import("@/lib/brief/week");
    const d = emptyDirectory();
    apply(d, confirmNew(d, { name: "Nitin", spellings: ["Nitin"] }, ctx()));
    apply(d, confirmNew(d, { name: "Nitin Kumar", spellings: ["Nitin Kumar"] }, ctx()));
    const m = meeting({ startedAt: "2026-11-24T05:00:00Z" });
    const items = resolveItems([item({ person: "Nitin", meetingId: m.id, createdAt: m.startedAt }), item({ person: "Nitin Kumar", meetingId: m.id, createdAt: m.startedAt })], d);
    const w = buildWeek({ items, meetings: [m] }, new Date("2026-11-25T10:00:00Z"), "Asia/Kolkata");
    expect(w.youOwe.map((p) => p.person).sort()).toEqual(["Nitin", "Nitin Kumar"]);
  });

  it("a confirmed person with no items still has a person page", () => {
    const d = emptyDirectory();
    apply(d, confirmNew(d, { name: "Ravi Shah", spellings: ["Ravi Shah"] }, ctx()));
    const found = personDetail("ravi-shah", { items: [], meetings: [], now: new Date(), people: d.people });
    expect(found?.person).toMatchObject({ name: "Ravi Shah", personId: d.people[0].id });
    expect(personDetail("nobody-here", { items: [], meetings: [], now: new Date(), people: d.people })).toBeNull();
  });
});
