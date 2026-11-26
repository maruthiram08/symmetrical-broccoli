import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "@/server/store";
import { connect, FakeWispr, fakeDeps, meeting as wisprMeeting } from "@/server/testing";
import { processMeeting, processPending } from "@/server/jobs/process";
import { pollUser } from "@/server/jobs/poll";
import { FileStore } from "@/server/local/file-store";
import type { Meeting, User } from "@/lib/types";
import { findGranolaCache, granolaStatus, granolaTranscript, parseGranolaCache, GranolaCacheError } from "./granola";
import { classifyInbox, clearScanCache, scanInbox, scanZoom, SETTLE_MS } from "./files";
import { isSameMeeting, titleSimilarity } from "./dedupe";
import { asYou, importSources, localTranscript } from ".";

// Every fixture is synthetic: made-up people and meetings, never a real transcript.
const F = join(__dirname, "fixtures");
const IST = "Asia/Kolkata";
const LATER = new Date("2030-01-01T00:00:00.000Z");

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "db-rec-")); clearScanCache(); });
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("Granola cache", () => {
  it("reads the v3 shape (cache as a JSON string): meetings with transcripts only, oldest first", () => {
    const docs = parseGranolaCache(readFileSync(join(F, "granola/cache-v3.json"), "utf8"));
    expect(docs.map((d) => d.id)).toEqual(["doc-aaa", "doc-bbb"]); // notes-only, deleted and malformed are skipped
    const [a, b] = docs;
    expect(a).toMatchObject({ title: "Pricing review", startedAt: "2026-11-24T04:30:00.000Z", participants: ["Asha Rao", "ravi@example.com"], lastAt: "2026-11-24T05:10:00.000Z" });
    expect(a.segments).toHaveLength(3); // the non-final segment is dropped
    expect(b).toMatchObject({ title: "Granola meeting", startedAt: "2026-11-25T08:01:00.000Z" });
    expect(granolaTranscript(a, "Test User")).toBe(
      "Them: Morning, let's look at the pricing page.\nTest User: I'll send the revised tiers to Ravi by Friday.\nThem: Great, I'll review them Monday.",
    );
  });

  it("picks the newest cache-vN.json and reads the object shape with a documents array", () => {
    const file = findGranolaCache(join(F, "granola-v4"));
    expect(file?.endsWith("cache-v4.json")).toBe(true);
    const docs = parseGranolaCache(readFileSync(file!, "utf8"));
    expect(docs).toEqual([expect.objectContaining({ id: "doc-ccc", title: "Board prep", startedAt: "2026-11-26T05:00:30.000Z" })]);
  });

  it("never requires the cache: missing folder, damaged file and unknown shapes", () => {
    expect(findGranolaCache(join(tmp, "nope"))).toBeNull();
    expect(granolaStatus(join(tmp, "nope"))).toEqual({ file: null, found: null, error: null });
    expect(granolaStatus(join(F, "granola-bad")).error).toMatch(/couldn't read cache-v3.json/);
    expect(() => parseGranolaCache("[]")).toThrow(GranolaCacheError);
    expect(() => parseGranolaCache('{"cache":{"state":{}}}')).toThrow(GranolaCacheError);
    expect(parseGranolaCache('{"cache":{"state":{"documents":{}}}}')).toEqual([]);
    expect(granolaStatus(join(F, "granola")).found).toBe(2);
  });
});

describe("Zoom folder", () => {
  it("finds one meeting per folder, prefers .vtt, skips chat logs, reads times from names", () => {
    const found = scanZoom(join(F, "zoom"), IST, LATER.getTime());
    expect(found.map((f) => [f.title, f.startedAt, f.sourcePath!.split("/").pop()])).toEqual([
      ["Asha Rao's Zoom Meeting", "2026-11-23T10:00:00.000Z", "meeting_saved_closed_caption.txt"],
      ["Pricing review", "2026-11-24T04:30:00.000Z", "audio_transcript.vtt"],
      ["Zoom meeting", "2026-11-22T04:30:00.000Z", "GMT20261122-043000_Recording.transcript.vtt"],
    ]);
    expect(found.every((f) => f.provider === "zoom" && f.providerMeetingId.startsWith("zoom:"))).toBe(true);
  });

  it("takes the time of day from captions when the folder has only a date", () => {
    mkdirSync(join(tmp, "2026-11-23 Launch"));
    writeFileSync(join(tmp, "2026-11-23 Launch", "closed_caption.txt"), "[Asha Rao] 15:31:05\nReady?\n");
    utimesSync(join(tmp, "2026-11-23 Launch", "closed_caption.txt"), new Date("2026-11-23T11:00:00Z"), new Date("2026-11-23T11:00:00Z"));
    expect(scanZoom(tmp, IST, LATER.getTime())[0]).toMatchObject({ title: "Launch", startedAt: "2026-11-23T10:01:05.000Z" });
  });

  it("waits for a file that is still being written, and is fine with a missing folder", () => {
    writeFileSync(join(tmp, "x.vtt"), "WEBVTT\n\n00:01.000 --> 00:02.000\nAsha: hi\n");
    expect(scanZoom(tmp, IST, Date.now())).toEqual([]);
    expect(scanZoom(tmp, IST, Date.now() + SETTLE_MS + 1000)).toHaveLength(1);
    expect(scanZoom(join(tmp, "nope"), IST, Date.now())).toEqual([]);
  });
});

describe("inbox folder", () => {
  it("imports every transcript type, tags phone calls and Meet docs, skips hidden and empty files", () => {
    const found = scanInbox(join(F, "inbox"), IST, LATER.getTime());
    const by = Object.fromEntries(found.map((f) => [f.title, f]));
    expect(Object.keys(by).sort()).toEqual(["Call with Ravi", "Phone call", "Product roadmap review", "Vendor onboarding", "Weekly design sync", "standup"]);
    expect(by["Call with Ravi"]).toMatchObject({ provider: "phone", startedAt: "2026-11-25T13:10:00.000Z", participants: ["Ravi", "Me"] });
    expect(by["Phone call"]).toMatchObject({ provider: "phone", startedAt: "2026-11-25T03:45:02.000Z" }); // inbox/phone/, time from the name
    expect(by["Weekly design sync"]).toMatchObject({ provider: "google_meet", startedAt: "2026-11-24T08:30:00.000Z" });
    expect(by["Product roadmap review"]).toMatchObject({ provider: "google_meet", startedAt: "2026-11-20T11:00:00.000Z" });
    expect(by["Vendor onboarding"]).toMatchObject({ provider: "file", startedAt: "2026-11-21T05:30:00.000Z" });
    expect(by["standup"].provider).toBe("file");
  });

  it("dates a file with no time in it by its mtime less its length", () => {
    const p = join(tmp, "standup.srt");
    cpSync(join(F, "inbox/standup.srt"), p);
    utimesSync(p, new Date("2026-11-25T05:00:05Z"), new Date("2026-11-25T05:00:05Z"));
    expect(scanInbox(tmp, IST, LATER.getTime())[0].startedAt).toBe("2026-11-25T05:00:00.000Z");
  });

  it("identifies a file by its contents: the same file twice is one meeting id", () => {
    cpSync(join(F, "inbox/standup.srt"), join(tmp, "a.srt"));
    cpSync(join(F, "inbox/standup.srt"), join(tmp, "b.srt"));
    const ids = scanInbox(tmp, IST, LATER.getTime()).map((f) => f.providerMeetingId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(1);
  });

  it("classifies by folder, name and contents", () => {
    const plain = { looksLikeMeet: false, looksLikePhone: false } as Parameters<typeof classifyInbox>[1];
    expect(classifyInbox("calls/x.txt", plain)).toBe("phone");
    expect(classifyInbox("meet/x.txt", plain)).toBe("google_meet");
    expect(classifyInbox("Phone call - plumber.txt", plain)).toBe("phone");
    expect(classifyInbox("x.txt", { ...plain, looksLikeMeet: true })).toBe("google_meet");
    expect(classifyInbox("x.txt", plain)).toBe("file");
  });
});

describe("dedupe", () => {
  const m = (title: string, startedAt: string, provider: Meeting["provider"], participants: string[] = []) => ({ title, startedAt, provider, participants });
  it("matches the same meeting from two recorders: close start and alike titles", () => {
    expect(isSameMeeting(m("Pricing review", "2026-11-24T04:30:00Z", "wispr_flow"), m("Pricing Review", "2026-11-24T04:38:00Z", "granola"))).toBe(true);
    expect(isSameMeeting(m("Pricing review", "2026-11-24T04:30:00Z", "wispr_flow"), m("Pricing review with Acme", "2026-11-24T04:25:00Z", "zoom"))).toBe(true);
  });
  it("keeps meetings apart when the time or the title differs, and never merges two Wispr meetings", () => {
    expect(isSameMeeting(m("Pricing review", "2026-11-24T04:30:00Z", "wispr_flow"), m("Pricing review", "2026-11-24T04:41:00Z", "granola"))).toBe(false);
    expect(isSameMeeting(m("Pricing review", "2026-11-24T04:30:00Z", "granola"), m("Hiring plan", "2026-11-24T04:31:00Z", "zoom"))).toBe(false);
    expect(isSameMeeting(m("Standup", "2026-11-24T04:30:00Z", "wispr_flow"), m("Standup", "2026-11-24T04:31:00Z", "wispr_flow"))).toBe(false);
  });
  it("with a generic title, a shared person or a start within 3 minutes stands in", () => {
    expect(isSameMeeting(m("Asha Rao's Zoom Meeting", "2026-11-24T04:30:00Z", "zoom", ["Asha Rao"]), m("Launch checklist", "2026-11-24T04:37:00Z", "wispr_flow", ["Asha"]))).toBe(true);
    expect(isSameMeeting(m("Zoom meeting", "2026-11-24T04:30:00Z", "zoom"), m("Launch checklist", "2026-11-24T04:32:00Z", "wispr_flow"))).toBe(true);
    expect(isSameMeeting(m("Zoom meeting", "2026-11-24T04:30:00Z", "zoom"), m("Launch checklist", "2026-11-24T04:37:00Z", "wispr_flow"))).toBe(false);
  });
  it("scores titles on meaningful words", () => {
    expect(titleSimilarity("Weekly design sync", "Design sync - Transcript")).toBe(1);
    expect(titleSimilarity("Design sync", "Pricing sync")).toBe(0);
  });
});

function userWith(store: MemoryStore, sources: User["sources"]): User {
  return store.addUser({ email: "a@x.com", name: "Test User", timeZone: IST, sources });
}

describe("importSources", () => {
  it("does nothing while every source is off (the default)", async () => {
    const store = new MemoryStore();
    const user = userWith(store, undefined);
    expect(await importSources(store, user, LATER)).toEqual({ found: 0, created: 0, duplicates: 0 });
    const off = userWith(store, { zoom: { enabled: false, path: join(F, "zoom") } });
    expect((await importSources(store, off, LATER)).found).toBe(0);
  });

  it("queues meetings from each turned-on source once, with provider and source file", async () => {
    const store = new MemoryStore();
    const user = userWith(store, { zoom: { enabled: true, path: join(F, "zoom") }, granola: { enabled: true, path: join(F, "granola") } });
    const r = await importSources(store, user, LATER);
    expect(r.found).toBe(5);
    // Granola's "Pricing review" is the Zoom "Pricing review" recorded twice.
    expect(r).toMatchObject({ created: 5, duplicates: 1 });
    const all = [...store.meetings.values()];
    const zoomPricing = all.find((m) => m.provider === "zoom" && m.title === "Pricing review")!;
    const granolaPricing = all.find((m) => m.provider === "granola" && m.title === "Pricing review")!;
    expect(zoomPricing.sourcePath).toMatch(/audio_transcript\.vtt$/);
    expect(granolaPricing.providerMeetingId).toBe("granola:doc-aaa");
    // Same start: whichever was queued first is kept, the other closes as its copy without a read.
    const [kept, copy] = granolaPricing.duplicateOf ? [zoomPricing, granolaPricing] : [granolaPricing, zoomPricing];
    expect(copy).toMatchObject({ duplicateOf: kept.id, processedAt: LATER.toISOString() });
    expect(kept.duplicateOf).toBeUndefined();
    expect((await store.listUnprocessedMeetings(user.id)).map((m) => m.id)).not.toContain(copy.id);
    expect((await store.listMeetingsBetween(user.id, "0000", "9999")).filter((m) => m.title === "Pricing review")).toHaveLength(1);
    expect(await importSources(store, user, LATER)).toMatchObject({ found: 5, created: 0 });
  });

  it("reads only meetings since the source was turned on", async () => {
    const store = new MemoryStore();
    const user = userWith(store, { granola: { enabled: true, path: join(F, "granola"), since: "2026-11-25T00:00:00.000Z" } });
    await importSources(store, user, LATER);
    expect([...store.meetings.values()].map((m) => m.providerMeetingId)).toEqual(["granola:doc-bbb"]);
  });

  it("leaves a Granola meeting that is still being recorded for later", async () => {
    const store = new MemoryStore();
    const user = userWith(store, { granola: { enabled: true, path: join(F, "granola") } });
    await importSources(store, user, new Date("2026-11-25T08:05:00.000Z"));
    expect([...store.meetings.values()].map((m) => m.providerMeetingId)).toEqual(["granola:doc-aaa"]);
  });

  it("splits the inbox between the Files and Phone switches", async () => {
    const store = new MemoryStore();
    const onlyPhone = userWith(store, { phone: { enabled: true, path: join(F, "inbox") } });
    await importSources(store, onlyPhone, LATER);
    expect(new Set([...store.meetings.values()].map((m) => m.provider))).toEqual(new Set(["phone"]));
    const store2 = new MemoryStore();
    const onlyFiles = userWith(store2, { files: { enabled: true, path: join(F, "inbox") } });
    await importSources(store2, onlyFiles, LATER);
    expect(new Set([...store2.meetings.values()].map((m) => m.provider))).toEqual(new Set(["google_meet", "file"]));
  });
});

describe("reading local meetings", () => {
  async function setup(sources: User["sources"]) {
    const store = new MemoryStore();
    const wispr = new FakeWispr();
    const user = userWith(store, sources);
    const f = fakeDeps({ store, wispr, now: LATER });
    return { store, wispr, user, ...f };
  }

  it("fetches the transcript by provider: files from disk, Granola from its cache, never through Wispr", async () => {
    const { store, wispr, user, deps, extractCalls } = await setup({ files: { enabled: true, path: join(F, "inbox") }, phone: { enabled: true, path: join(F, "inbox") }, granola: { enabled: true, path: join(F, "granola") } });
    await importSources(store, user, LATER);
    const r = await processPending(deps, user.id); // no Wispr connection at all
    expect(r).toMatchObject({ processed: 8, failed: 0 });
    expect(wispr.transcriptCalls).toEqual([]);
    const meet = extractCalls.find((c) => c.meeting.title === "Weekly design sync")!;
    expect(meet.transcript).toContain("Meera Iyer: I'll have the new mocks ready by Wednesday.");
    const call = extractCalls.find((c) => c.meeting.title === "Call with Ravi")!;
    expect(call.transcript).toContain("Test User: Not yet, I'll read it tonight"); // "Me:" becomes your name
    const gr = extractCalls.find((c) => c.meeting.title === "Pricing review")!;
    expect(gr.transcript).toContain("Test User: I'll send the revised tiers");
    expect(JSON.stringify(store.events)).not.toContain("revised tiers");
  });

  it("counts a missing source file as a transcript failure", async () => {
    const { store, user, deps } = await setup({});
    const { meeting } = await store.upsertMeeting({ userId: user.id, provider: "file", providerMeetingId: "file:gone", title: "Gone", startedAt: "2026-11-24T04:30:00.000Z", participants: [], sourcePath: join(tmp, "gone.txt") });
    await expect(processMeeting(deps, meeting.id)).rejects.toMatchObject({ name: "ProcessError", kind: "transcript" });
  });

  it("still reads Wispr Flow meetings with the shared client, and local ones while Wispr needs a reconnect", async () => {
    const { store, wispr, user, deps } = await setup({ zoom: { enabled: true, path: join(F, "zoom") } });
    connect(store, user.id, { status: "needs_reconnect" });
    await store.upsertMeeting({ userId: user.id, providerMeetingId: "w1", title: "Wispr one", startedAt: "2026-11-20T04:30:00.000Z", participants: [] });
    await importSources(store, user, LATER);
    const r = await processPending(deps, user.id);
    expect(r).toMatchObject({ processed: 3, stoppedBy: "reconnect", remaining: 1 });
    expect(wispr.transcriptCalls).toEqual([]);
    connect(store, user.id);
    wispr.transcripts.set("w1", "Asha: hi");
    expect(await processPending(deps, user.id)).toMatchObject({ processed: 1 });
    expect(wispr.transcriptCalls).toEqual(["w1"]);
  });

  it("a Wispr Flow meeting that a local recorder already brought in is not read twice", async () => {
    const { store, wispr, user, deps } = await setup({ zoom: { enabled: true, path: join(F, "zoom") } });
    connect(store, user.id);
    await importSources(store, user, LATER);
    wispr.meetings.set(user.id, [wisprMeeting("w-pricing", "2026-11-24T04:33:00.000Z", { title: "Pricing review" }), wisprMeeting("w-other", "2026-11-24T06:00:00.000Z", { title: "Other" })]);
    await pollUser(deps, user.id, { since: "2026-11-01T00:00:00.000Z" });
    const w = [...store.meetings.values()].find((m) => m.providerMeetingId === "w-pricing")!;
    expect(w.provider).toBe("wispr_flow");
    expect(w.duplicateOf).toBeTruthy();
    expect([...store.meetings.values()].find((m) => m.providerMeetingId === "w-other")!.duplicateOf).toBeUndefined();
    await processPending(deps, user.id);
    expect(wispr.transcriptCalls).toEqual(["w-other"]);
  });

  it("labels Me/You lines with the user's name", () => {
    expect(asYou("Me: I'll do it\nRavi: ok\nyou: sure", "Test User")).toBe("Test User: I'll do it\nRavi: ok\nTest User: sure");
  });

  it("localTranscript refuses Wispr Flow meetings", async () => {
    const m = { id: "x", userId: "u", providerMeetingId: "p", title: "", startedAt: "", participants: [], processedAt: null } as Meeting;
    await expect(localTranscript(m, { name: "A", timeZone: IST })).rejects.toThrow();
  });
});

describe("FileStore", () => {
  it("gives meetings stored before recorders the wispr_flow provider, and keeps duplicates across reloads", async () => {
    const path = join(tmp, "state.json");
    const old = { version: 1, users: [{ id: "u", email: "a", name: "A", aliases: [], timeZone: IST, briefTime: "18:00", createdAt: "2026-01-01" }], connections: [], items: [], briefs: [], oauthClients: [], events: [],
      meetings: [{ id: "m1", userId: "u", providerMeetingId: "p1", title: "Old", startedAt: "2026-11-01T00:00:00.000Z", participants: [], processedAt: null }] };
    writeFileSync(path, JSON.stringify(old));
    const s = new FileStore(path);
    expect((await s.getMeeting("m1"))?.provider).toBe("wispr_flow");
    // The same id from another recorder is a different meeting.
    const r = await s.upsertMeeting({ userId: "u", provider: "granola", providerMeetingId: "p1", title: "Old", startedAt: "2026-11-01T00:02:00.000Z", participants: [] });
    expect(r.created).toBe(true);
    await s.markMeetingDuplicate(r.meeting.id, "m1", "2026-11-02T00:00:00.000Z");
    const again = new FileStore(path);
    expect(await again.getMeeting(r.meeting.id)).toMatchObject({ duplicateOf: "m1", processedAt: "2026-11-02T00:00:00.000Z" });
    expect((await again.listUnprocessedMeetings("u")).map((m) => m.id)).toEqual(["m1"]);
  });
});

describe("scheduler tick", () => {
  it("imports from local sources every tick and reads new ones without waiting for the 30-minute poll", async () => {
    const { runTick, newTickState } = await import("@/server/local/scheduler");
    const store = new MemoryStore();
    const wispr = new FakeWispr();
    const user = userWith(store, { files: { enabled: true, path: tmp } });
    const { deps, extractCalls } = fakeDeps({ store, wispr, now: LATER });
    const st = newTickState();
    st.lastPoll = LATER.getTime(); // the Wispr poll just ran
    const first = await runTick(deps, st, { nowMs: LATER.getTime() });
    expect(first.polled).toBe(false);
    expect(store.meetings.size).toBe(0);
    cpSync(join(F, "inbox/vendor-notes.md"), join(tmp, "vendor-notes.md"));
    utimesSync(join(tmp, "vendor-notes.md"), new Date("2026-11-21T06:00:00Z"), new Date("2026-11-21T06:00:00Z"));
    await runTick(deps, st, { nowMs: LATER.getTime() + 1000 });
    expect([...store.meetings.values()]).toEqual([expect.objectContaining({ provider: "file", title: "Vendor onboarding", userId: user.id })]);
    expect(extractCalls.map((c) => c.meeting.title)).toEqual(["Vendor onboarding"]);
    await runTick(deps, st, { nowMs: LATER.getTime() + 2000 });
    expect(extractCalls).toHaveLength(1);
  });
});

describe("Settings rules", () => {
  it("turning Granola or Zoom on reads 7 days back, and keeps that through off and on", async () => {
    const { changeSource } = await import("./settings");
    const now = new Date("2026-11-26T00:00:00.000Z");
    const on = changeSource(undefined, "granola", { enabled: true }, now);
    expect(on.granola).toEqual({ enabled: true, since: "2026-11-19T00:00:00.000Z" });
    const off = changeSource(on, "granola", { enabled: false }, new Date("2026-12-26T00:00:00.000Z"));
    const again = changeSource(off, "granola", { enabled: true }, new Date("2026-12-26T00:00:00.000Z"));
    expect(again.granola?.since).toBe("2026-11-19T00:00:00.000Z");
    expect(changeSource(undefined, "files", { enabled: true }, now).files).toEqual({ enabled: true });
  });
  it("files and phone share one inbox folder, and '' goes back to the default", async () => {
    const { changeSource } = await import("./settings");
    const s = changeSource({ phone: { enabled: true } }, "files", { path: "/x/inbox" }, LATER);
    expect(s).toEqual({ files: { enabled: false, path: "/x/inbox" }, phone: { enabled: true, path: "/x/inbox" } });
    expect(changeSource(s, "files", { path: "" }, LATER).files?.path).toBeNull();
  });
  it("cleans folder paths", async () => {
    const { cleanPath } = await import("./settings");
    expect(cleanPath("  /Users/a/Zoom ")).toBe("/Users/a/Zoom");
    expect(cleanPath("~/Documents/Zoom")).toMatch(/\/Documents\/Zoom$/);
    expect(cleanPath("relative/dir")).toBeNull();
    expect(cleanPath("")).toBeNull();
  });
  it("saves uploads into the inbox without overwriting, ready to import at once", async () => {
    const { saveUpload, UploadError } = await import("./settings");
    const data = readFileSync(join(F, "inbox/standup.srt"));
    const a = saveUpload(join(tmp, "inbox"), "../../standup.srt", data);
    const b = saveUpload(join(tmp, "inbox"), "standup.srt", data);
    expect(a).toBe(join(tmp, "inbox", "standup.srt"));
    expect(b).toBe(join(tmp, "inbox", "standup (2).srt"));
    expect(() => saveUpload(tmp, "movie.mp4", data)).toThrow(UploadError);
    expect(() => saveUpload(tmp, "x.txt", Buffer.alloc(0))).toThrow(UploadError);
    expect(scanInbox(join(tmp, "inbox"), IST, Date.now())).toHaveLength(2); // no settle wait
  });
  it("Settings status counts what each source holds", async () => {
    const { sourceStatuses } = await import("./status");
    const store = new MemoryStore();
    const user = userWith(store, { zoom: { enabled: true, path: join(F, "zoom"), since: "2026-11-23T00:00:00.000Z" }, granola: { enabled: false, path: join(F, "granola") }, files: { enabled: false, path: join(tmp, "nope") } });
    const st = Object.fromEntries(sourceStatuses(user, [], LATER).map((s) => [s.key, s]));
    expect(st.zoom).toMatchObject({ enabled: true, present: true, found: 3, sinceCount: 2 });
    expect(st.granola).toMatchObject({ enabled: false, present: true, found: 2, sinceCount: 0 });
    expect(st.files).toMatchObject({ present: false, found: null });
    expect(st.phone.path).toBe(join(tmp, "nope"));
  });
});
