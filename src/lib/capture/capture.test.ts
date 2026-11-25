import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildBrief } from "@/lib/brief/build";
import { renderMarkdown } from "@/lib/brief/markdown";
import type { BriefModel, Item } from "@/lib/types";
import { FileStore, dedupeBatches } from "@/server/local/file-store";
import { publishLocal } from "@/server/local/publish";
import { MemoryStore } from "@/server/store";
import { isSnoozed, migrateItem, starredFirst } from "./items";
import { carryNotes, NOTES_END, NOTES_START, splitNotes, withNotes } from "./notes";

const TZ = "Asia/Kolkata";
const tmp = () => mkdtempSync(join(tmpdir(), "db-capture-"));

async function seed(s: MemoryStore) {
  const user = s.addUser({ email: "m@example.com", name: "Maruthi", timeZone: TZ });
  const { meeting } = await s.upsertMeeting({ userId: user.id, providerMeetingId: "p1", title: "Standup", startedAt: "2026-11-20T05:00:00Z", participants: [] });
  await s.commitExtraction({ meetingId: meeting.id, userId: user.id, at: "2026-11-20T06:00:00Z", closes: [], newItems: [
    { kind: "owe", text: "Old promise A", person: "Nitin", quote: "I'll do A", meetingId: meeting.id, dueAt: null },
    { kind: "owe", text: "Old promise B", person: "Nitin", quote: "I'll do B", meetingId: meeting.id, dueAt: null },
  ] });
  return { user, meeting };
}

describe("manual items in the store", () => {
  it("adds, edits and deletes your own items, kept across restarts", async () => {
    const path = join(tmp(), ".daily-brief", "state.json");
    const a = new FileStore(path);
    const { user } = await seed(a);
    const item = await a.addManualItem(user.id, { kind: "owe", text: " Send Nitin the deck ", person: "Nitin", dueAt: "2026-11-27T12:30:00.000Z", note: "the v2 one" }, "2026-11-25T06:00:00Z");
    expect(item).toMatchObject({ source: "manual", text: "Send Nitin the deck", quote: "", meetingId: "manual", status: "open", note: "the v2 one" });

    const b = new FileStore(path);
    expect((await b.listItems(user.id)).find((i) => i.id === item.id)?.text).toBe("Send Nitin the deck");
    await b.updateItem(item.id, { text: "Send Nitin the final deck", starred: true });
    await b.setItemStatus(item.id, "done", "2026-11-25T07:00:00Z");
    const c = new FileStore(path);
    expect((await c.listItems(user.id)).find((i) => i.id === item.id)).toMatchObject({ text: "Send Nitin the final deck", starred: true, status: "done" });
    expect(await c.deleteItem(item.id)).toBe(true);
    expect((await new FileStore(path).listItems(user.id)).some((i) => i.id === item.id)).toBe(false);
  });

  it("loads a state file from before manual items (no source) as extracted items", async () => {
    const dir = tmp();
    const path = join(dir, "state.json");
    const old: Item = { id: "i1", userId: "u", kind: "owe", text: "x", person: null, quote: "q", meetingId: "m", dueAt: null, status: "open", closedByMeetingId: null, closeQuote: null, createdAt: "2026-11-01T00:00:00Z", closedAt: null };
    writeFileSync(path, JSON.stringify({ version: 1, users: [], connections: [], meetings: [], items: [old], briefs: [], oauthClients: [], events: [] }));
    const s = new FileStore(path);
    expect((await s.listItems("u"))[0]).toMatchObject({ id: "i1", source: "extracted" });
    expect(migrateItem({ ...old, source: "manual" }).source).toBe("manual");
  });

  it("never treats manual items as a duplicate meeting batch", () => {
    const m = (id: string, createdAt: string): Item => ({ id, userId: "u", kind: "owe", text: id, person: null, quote: "", meetingId: "manual", dueAt: null, status: "open", closedByMeetingId: null, closeQuote: null, createdAt, closedAt: null, source: "manual" });
    const items = new Map([["a", m("a", "2026-11-01T00:00:00Z")], ["b", m("b", "2026-11-02T00:00:00Z")]]);
    expect(dedupeBatches(items)).toBe(false);
    expect(items.size).toBe(2);
  });

  it("keeps manual items, stars and snoozes when every meeting is read again", async () => {
    const s = new FileStore(join(tmp(), "state.json"));
    const { user, meeting } = await seed(s);
    const mine = await s.addManualItem(user.id, { kind: "waiting", text: "Tarun to send API spec", person: "Tarun", dueAt: null }, "2026-11-25T06:00:00Z");
    const [a, b] = (await s.listItems(user.id)).filter((i) => i.source === "extracted");
    await s.updateItem(a.id, { starred: true });
    await s.updateItem(b.id, { snoozedUntil: "2026-12-01" });
    await s.resetExtraction(user.id);
    expect((await s.listItems(user.id)).map((i) => i.id)).toEqual([mine.id]);
    await s.commitExtraction({ meetingId: meeting.id, userId: user.id, at: "2026-11-26T06:00:00Z", closes: [], newItems: [
      { kind: "owe", text: "Old promise A", person: "Nitin", quote: "I'll do A", meetingId: meeting.id, dueAt: null },
      { kind: "owe", text: "Old promise B", person: "Nitin", quote: "I'll do B", meetingId: meeting.id, dueAt: null },
    ] });
    const again = await s.listItems(user.id);
    expect(again.find((i) => i.text === "Old promise A")).toMatchObject({ starred: true, status: "open" });
    expect(again.find((i) => i.text === "Old promise B")).toMatchObject({ snoozedUntil: "2026-12-01", status: "open" });
  });
});

describe("stars and snoozes in the brief", () => {
  it("pins starred items to the top, hides snoozed ones, and shows your own items from today", async () => {
    const s = new MemoryStore();
    const { user } = await seed(s);
    const now = new Date("2026-11-25T10:00:00Z");
    const [a, b] = await s.listItems(user.id);
    const mine = await s.addManualItem(user.id, { kind: "owe", text: "Renew the passport", person: null, dueAt: null }, "2026-11-25T06:00:00Z");
    const due = await s.addManualItem(user.id, { kind: "owe", text: "Pay the vendor", person: null, dueAt: "2026-11-25T08:00:00Z" }, "2026-11-25T06:01:00Z");

    let brief = await buildBrief(s, user, now);
    expect(brief.youOwe.map((l) => l.text)).toEqual(["Pay the vendor", "Renew the passport"]);
    expect(brief.youOwe[1]).toMatchObject({ manual: true, itemId: mine.id });
    expect(brief.stillOpen.map((l) => l.text)).toEqual(["Old promise A", "Old promise B"]);

    await s.updateItem(b.id, { starred: true }); // starred: on Today, at the top, even when late ones exist
    await s.updateItem(a.id, { snoozedUntil: "2026-11-27" });
    brief = await buildBrief(s, user, now);
    expect(brief.youOwe.map((l) => l.text)).toEqual(["Old promise B", "Pay the vendor", "Renew the passport"]);
    expect(brief.youOwe[0].starred).toBe(true);
    expect(brief.stillOpenCount).toBe(0);
    expect(brief.youOwe.find((l) => l.itemId === due.id)?.lateLabel).toBe("2h late");

    // On the snooze day it is back.
    brief = await buildBrief(s, user, new Date("2026-11-27T05:00:00Z"));
    expect([...brief.youOwe, ...brief.stillOpen].map((l) => l.text)).toContain("Old promise A");

    const md = renderMarkdown(await buildBrief(s, user, now));
    expect(md).toContain("- [ ] ★ Old promise B");
    expect(md).toContain("- [ ] Renew the passport\n  Added by you");
  });

  it("helpers", () => {
    expect(isSnoozed({ snoozedUntil: "2026-11-27" }, "2026-11-26")).toBe(true);
    expect(isSnoozed({ snoozedUntil: "2026-11-27" }, "2026-11-27")).toBe(false);
    expect(isSnoozed({}, "2026-11-27")).toBe(false);
    expect(starredFirst([{ n: 1 }, { n: 2, starred: true }, { n: 3 }, { n: 4, starred: true }]).map((x) => x.n)).toEqual([2, 4, 1, 3]);
  });
});

describe("your notes in the daily note", () => {
  const brief = "---\ndate: 2026-11-25\n---\n\n# Wednesday, 25 November\n\n## You owe\n\n- [ ] Send it\n";

  it("puts notes between markers at the end, and reads them back", () => {
    const md = withNotes(brief, "Called the bank.\n\n- ask about the fee");
    expect(md).toBe(`${brief}\n${NOTES_START}\n## Your notes\n\nCalled the bank.\n\n- ask about the fee\n${NOTES_END}\n`);
    expect(splitNotes(md)).toEqual({ brief, notes: "Called the bank.\n\n- ask about the fee" });
    expect(withNotes(withNotes(md, "changed"), "changed")).toBe(withNotes(brief, "changed"));
    expect(withNotes(md, "  ")).toBe(brief);
    expect(splitNotes(brief)).toEqual({ brief, notes: null });
  });

  it("can't be cut short by a line that looks like the end marker", () => {
    const md = withNotes(brief, `a\n${NOTES_END}\nb`);
    expect(splitNotes(md).notes).toContain("b");
    expect(splitNotes(md).brief).toBe(brief);
  });

  it("survives the brief being written again", async () => {
    expect(carryNotes("# new\n", withNotes("# old\n", "keep me"))).toBe(withNotes("# new\n", "keep me"));
    expect(carryNotes("# new\n", "# old, no notes\n")).toBe("# new\n");
    expect(carryNotes("# new\n", null)).toBe("# new\n");

    const dir = tmp();
    const model = { date: "2026-11-25", decisions: [], subject: "s", empty: "no_meetings", youOwe: [] } as unknown as BriefModel;
    writeFileSync(join(dir, "2026-11-25.md"), withNotes("# first\n", "my words"));
    await publishLocal(dir, {} as never, model, "# second\n", () => {});
    expect(readFileSync(join(dir, "2026-11-25.md"), "utf8")).toBe(withNotes("# second\n", "my words"));
  });
});

describe("your own items elsewhere", () => {
  const base: Item = { id: "x", userId: "u", kind: "waiting", text: "Tarun to send API spec", person: "Tarun", quote: "", meetingId: "manual", dueAt: null, status: "open", closedByMeetingId: null, closeQuote: null, createdAt: "2026-11-20T06:00:00Z", closedAt: null, source: "manual" };
  it("is never a meeting 'mentioning' or 'related to' another item", async () => {
    const { timeline, relatedItems } = await import("@/lib/wow/timeline");
    const meetingItem: Item = { ...base, id: "m", source: "extracted", quote: "I'll send the API spec", meetingId: "mt", createdAt: "2026-11-19T06:00:00Z" };
    const later: Item = { ...base, id: "later", createdAt: "2026-11-21T06:00:00Z" };
    const mt = { id: "mt", userId: "u", providerMeetingId: "p", title: "Sync", startedAt: "2026-11-19T05:00:00Z", participants: [], processedAt: "x" };
    expect(timeline(meetingItem, [meetingItem, later], [mt], new Date("2026-11-25T00:00:00Z")).some((e) => e.kind === "mentioned")).toBe(false);
    expect(relatedItems(later, [meetingItem, base, later], [mt]).map((r) => r.item.id)).toEqual(["m"]);
  });
  it("nudge drafts read fine without a quote", async () => {
    const { templateNudge, buildNudgeMessage } = await import("@/lib/nudge/nudge");
    const ctx = { user: { name: "Maruthi", timeZone: TZ }, item: { ...base, dueAt: "2026-11-20T12:30:00Z" }, meeting: null, related: [], now: "2026-11-25T06:00:00Z" } as never;
    expect(templateNudge(ctx)).toBe("Hi Tarun, quick nudge on this: Tarun to send API spec. Any update on when it'll be done?");
    expect(buildNudgeMessage(ctx)).toContain("added this item by hand");
  });
});
