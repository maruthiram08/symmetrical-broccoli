import { describe, expect, it } from "vitest";
import type { Item } from "@/lib/types";
import { priorityContext, priorityOf, rankByPriority, topN } from "./priority";

const NOW = new Date("2026-11-26T06:00:00Z");
const H = 3_600_000;
const iso = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

let n = 0;
function item(p: Partial<Item>): Item {
  return {
    id: `i${++n}`, userId: "u", kind: "owe", text: "Do a thing", person: null, quote: "", meetingId: "m",
    dueAt: null, status: "open", closedByMeetingId: null, closeQuote: null, createdAt: NOW.toISOString(), closedAt: null, ...p,
  };
}

describe("priorityOf", () => {
  it("scores nothing for a fresh undated item", () => {
    const i = item({});
    expect(priorityOf(i, { now: NOW, items: [i] })).toEqual({ score: 0, reasons: [] });
  });

  it("ranks overdue above due soon above due later, and grows with lateness", () => {
    const late3 = item({ dueAt: iso(-3 * 24 * H) });
    const late1h = item({ dueAt: iso(-H) });
    const soon = item({ dueAt: iso(5 * H) });
    const twoDays = item({ dueAt: iso(48 * H) });
    const week = item({ dueAt: iso(7 * 24 * H) });
    const all = [late3, late1h, soon, twoDays, week];
    const ctx = { now: NOW, items: all };
    const s = all.map((i) => priorityOf(i, ctx).score);
    expect(s[0]).toBeGreaterThan(s[1]);
    expect(s[1]).toBeGreaterThan(s[2]);
    expect(s[2]).toBeGreaterThan(s[3]);
    expect(s[3]).toBeGreaterThan(s[4]);
    expect(s[4]).toBe(0);
    expect(priorityOf(late3, ctx).reasons[0]).toBe("3d late");
    expect(priorityOf(soon, ctx).reasons[0]).toBe("due in 5h");
  });

  it("caps lateness, adds stars, people waiting and age with reasons", () => {
    const old = item({ dueAt: iso(-60 * 24 * H) });
    expect(priorityOf(old, { now: NOW, items: [old] }).score).toBe(100);
    const a = item({ person: "Nitin K", starred: true, createdAt: iso(-10 * 24 * H) });
    const b = item({ person: "nitin k" });
    const c = item({ person: "Nitin K", status: "done" });
    const p = priorityOf(a, { now: NOW, items: [a, b, c] });
    expect(p.score).toBe(35 + 6 + 10);
    expect(p.reasons).toEqual(["starred", "open 10d", "Nitin K waits on 2"]);
  });

  it("counts age from the meeting, not when the item was stored", () => {
    const i = item({ meetingId: "m1", createdAt: NOW.toISOString() });
    const ctx = priorityContext([i], [{ id: "m1", startedAt: iso(-5 * 24 * H) }], NOW);
    expect(priorityOf(i, ctx).reasons).toEqual(["open 5d"]);
  });

  it("ignores due dates on closed items", () => {
    const i = item({ dueAt: iso(-H), status: "done" });
    expect(priorityOf(i, { now: NOW, items: [i] }).score).toBe(0);
  });
});

describe("rankByPriority / topN", () => {
  it("sorts highest first, keeps order on ties, and Top 3 skips zero scores", () => {
    const a = item({ text: "a" });
    const b = item({ text: "b", dueAt: iso(2 * H) });
    const c = item({ text: "c" });
    const d = item({ text: "d", dueAt: iso(-2 * H) });
    const ranked = rankByPriority([a, b, c, d], (x) => x.id, { now: NOW, items: [a, b, c, d] });
    expect(ranked.map((x) => x.text)).toEqual(["d", "b", "a", "c"]);
    expect(topN(ranked).map((x) => x.text)).toEqual(["d", "b"]);
  });

  it("works on brief lines by item id and gives unknown ids a zero score", () => {
    const a = item({ dueAt: iso(-H) });
    const lines = [{ itemId: "missing" }, { itemId: a.id }];
    const ranked = rankByPriority(lines, (l) => l.itemId, { now: NOW, items: [a] });
    expect(ranked.map((l) => l.itemId)).toEqual([a.id, "missing"]);
    expect(ranked[1].priority).toEqual({ score: 0, reasons: [] });
  });
});
