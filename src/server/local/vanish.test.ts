// Items must never disappear without a user action: hand edits, two processes on one state.json,
// a damaged file seen by a running process.
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Item } from "@/lib/types";
import { MemoryStore } from "@/server/store";
import { dedupeBatches, FileStore, RECOVERED_FROM_MEMORY } from "./file-store";

const tmp = () => join(mkdtempSync(join(tmpdir(), "db-vanish-")), "state.json");

const item = (id: string, over: Partial<Item>): Item => ({
  id, userId: "u", kind: "owe", text: id, person: null, quote: "", meetingId: "m1", dueAt: null, source: "extracted",
  status: "open", closedByMeetingId: null, closeQuote: null, createdAt: "2026-11-25T06:30:00.000Z", closedAt: null, ...over,
});

afterEach(() => vi.restoreAllMocks());

describe("dedupeBatches never drops the only copy of an item", () => {
  it("keeps a seeded batch when an item was added by hand to the same meeting with an earlier createdAt", async () => {
    // What happened: the hand-added decision (06:00) became the "first batch" and the seeded
    // 06:30 batch (Send Arjun the banner copy, Move standup to 10:30) was deleted on load.
    const path = tmp();
    const a = new FileStore(path);
    const u = a.addUser({ email: "x" });
    const seeded = [
      item("arjun", { userId: u.id, text: "Send Arjun the banner copy for the FAQ", quote: "I'll forward you the banner text" }),
      item("standup", { userId: u.id, kind: "decision", text: "Move standup to 10:30", quote: "let's do 10:30" }),
    ];
    for (const i of seeded) a.items.set(i.id, i);
    a.flush();
    const s = JSON.parse(readFileSync(path, "utf8"));
    s.items.push(item("hand", { userId: u.id, kind: "decision", text: "Launch on the 9th of December", quote: "let's push launch to the 9th", createdAt: "2026-11-25T06:00:00.000Z" }));
    writeFileSync(path, JSON.stringify(s));
    expect((await new FileStore(path).listItems(u.id)).map((i) => i.id).sort()).toEqual(["arjun", "hand", "standup"]);
  });

  it("still removes items read twice, and only those", () => {
    const later = "2026-11-25T07:00:00.000Z";
    const items = new Map([
      item("a1", { text: "Send the deck to Priya", quote: "I'll send you the deck" }),
      item("a2", { kind: "decision", text: "Ship on Monday", quote: "we ship Monday" }),
      item("b1", { text: "Send the deck to Priya", quote: "I will send you the deck", createdAt: later }), // same text
      item("b2", { kind: "decision", text: "We ship on Monday", quote: "we ship Monday", createdAt: later }), // same quote
      item("b3", { text: "Book the room", quote: "I'll book it", createdAt: later }), // only copy
      item("b4", { text: "Send the deck to Priya", quote: "I'll send you the deck", createdAt: later, starred: true }), // touched
    ].map((i) => [i.id, i]));
    expect(dedupeBatches(items)).toBe(true);
    expect([...items.keys()].sort()).toEqual(["a1", "a2", "b3", "b4"]);
    expect(dedupeBatches(items)).toBe(false);
  });
});

describe("two processes writing one state.json", () => {
  it("sees another write even when it has the same mtime (a coarse clock tick)", async () => {
    const path = tmp();
    const a = new FileStore(path);
    const u = a.addUser({ email: "x" });
    const kept = await a.addManualItem(u.id, { kind: "owe", text: "First", person: null, dueAt: null, note: null }, "2026-11-25T06:00:00Z");
    const tick = 1_795_600_000; // whole seconds, so the timestamp is exactly the same both times
    utimesSync(path, tick, tick);
    await a.listItems(u.id); // a has now seen the file at this timestamp
    const b = new FileStore(path);
    const theirs = await b.addManualItem(u.id, { kind: "owe", text: "Second", person: null, dueAt: null, note: null }, "2026-11-25T06:00:00Z");
    utimesSync(path, tick, tick); // b's write lands in the same tick
    await a.setItemStatus(kept.id, "done", "2026-11-25T07:00:00Z");
    expect((await new FileStore(path).listItems(u.id)).map((i) => i.text).sort()).toEqual(["First", "Second"]);
    expect((await new FileStore(path).listItems(u.id)).find((i) => i.id === theirs.id)?.status).toBe("open");
  });

  it("makes its change again on top of a write that landed while it was changing", async () => {
    const path = tmp();
    const a = new FileStore(path);
    const u = a.addUser({ email: "x" });
    const mine = await a.addManualItem(u.id, { kind: "owe", text: "Mine", person: null, dueAt: null, note: null }, "2026-11-25T06:00:00Z");
    const b = new FileStore(path);
    const original = MemoryStore.prototype.setItemStatus;
    vi.spyOn(MemoryStore.prototype, "setItemStatus").mockImplementationOnce(async function (this: MemoryStore, ...args) {
      await b.addManualItem(u.id, { kind: "waiting", text: "From the MCP server", person: null, dueAt: null, note: null }, "2026-11-25T06:01:00Z");
      return original.apply(this, args);
    });
    await a.setItemStatus(mine.id, "done", "2026-11-25T07:00:00Z");
    const after = await new FileStore(path).listItems(u.id);
    expect(after.map((i) => [i.text, i.status]).sort()).toEqual([["From the MCP server", "open"], ["Mine", "done"]]);
  });
});

describe("a damaged state.json seen by a running process", () => {
  it("is written again from memory, not rolled back to an older backup", async () => {
    const path = tmp();
    const a = new FileStore(path);
    const u = a.addUser({ email: "x" }); // the hourly backup is taken here
    await a.addManualItem(u.id, { kind: "owe", text: "Added after the backup", person: null, dueAt: null, note: null }, "2026-11-25T06:00:00Z");
    expect(readFileSync(`${path}.bak`, "utf8")).not.toContain("Added after the backup");
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    writeFileSync(path, readFileSync(path, "utf8").slice(0, 40)); // a hand edit half written
    expect((await a.listItems(u.id)).map((i) => i.text)).toEqual(["Added after the backup"]);
    expect((await a.getRecovery())?.from).toBe(RECOVERED_FROM_MEMORY);
    expect((await new FileStore(path).listItems(u.id)).map((i) => i.text)).toEqual(["Added after the backup"]);
    expect(err).toHaveBeenCalled();
  });
});
