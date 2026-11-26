// Lays out the five canvas views from stored items and meetings. Pure: pages load the data and pass
// it in, so every view is rebuilt from the latest meetings on each visit (nothing to maintain).
import { isSpeakerLabel } from "../directory/speakers";
import { addDays, dueLabel, localDate, zonedTime } from "../brief/time";
import type { Item, Meeting } from "../types";
import type { CanvasDoc, CanvasEdge, CanvasNode, CanvasWindow, NodeAction } from "./model";
import { cardHeight, clip, mentions, sentence, words } from "./text";
import { groupItems, meetingsAbout } from "./topics";

export interface Ctx {
  items: Item[];
  meetings: Meeting[];
  /** The user's own name and aliases: never shown as a person. */
  self: string[];
  timeZone: string;
  now: Date;
}

export const COL_W = 230;
const GAP_X = 30;
const GAP_Y = 18;
const TOP = 24;
export const MAP_MAX_MEETINGS = 6;
const PER_COLUMN = 4;

const DAY = 86400000;
const short = (iso: string, tz: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: tz });
const weekday = (iso: string, tz: string) => new Date(iso).toLocaleDateString("en-GB", { weekday: "short", timeZone: tz });
const clock = (iso: string, tz: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz });

function isSelf(name: string, self: string[]): boolean {
  const n = name.trim().toLowerCase();
  return self.some((s) => s.trim().toLowerCase() === n || s.trim().toLowerCase().split(/\s+/)[0] === n);
}

/** People in a meeting, without the user and without "Speaker 5" labels. */
export function others(m: Meeting, self: string[]): string[] {
  return m.participants.filter((p) => p && !isSpeakerLabel(p) && !isSelf(p, self));
}

function meetingNode(m: Meeting, c: Ctx, x: number, y: number, w = COL_W, label?: string): CanvasNode {
  const who = others(m, c.self);
  return {
    id: `meeting:${m.id}`, kind: "meeting", x, y, w, meetingId: m.id, context: true,
    label: label ?? `Meeting · ${weekday(m.startedAt, c.timeZone)} ${short(m.startedAt, c.timeZone)}`,
    title: m.title || "Meeting",
    sub: who.length ? `${who.slice(0, 3).join(", ")}${who.length > 3 ? ` +${who.length - 3}` : ""}` : undefined,
    href: `/meeting/${encodeURIComponent(m.id)}`,
  };
}

/** The small line above an item: who, and how late or how long. */
export function itemLabel(i: Item, c: Ctx, meetings: Map<string, Meeting>): string {
  const who = i.person && !isSpeakerLabel(i.person) ? i.person : null;
  if (i.status === "done") {
    const by = i.closedByMeetingId ? meetings.get(i.closedByMeetingId) : null;
    return `Done${i.closedAt ? ` · closed ${short(i.closedAt, c.timeZone)}` : ""}${by ? ` in “${clip(by.title, 28)}”` : ""}`;
  }
  if (i.kind === "decision") return "Decision";
  const from = meetings.get(i.meetingId)?.startedAt ?? i.createdAt;
  const age = Math.floor((c.now.getTime() - Date.parse(from)) / DAY);
  if (i.kind === "owe") {
    const due = i.dueAt ? ` · ${dueLabel(i.dueAt, c.now, c.timeZone).toLowerCase()}` : age >= 3 ? ` · ${age} days` : "";
    return `You owe${who ? ` ${who}` : ""}${due}`;
  }
  return `Waiting on ${who ?? "someone"}${age >= 1 ? ` · ${age} day${age === 1 ? "" : "s"}` : ""}`;
}

function itemNode(i: Item, c: Ctx, meetings: Map<string, Meeting>, x: number, y: number, w = COL_W, extra: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id: `item:${i.id}`, kind: i.kind, x, y, w, itemId: i.id, context: true, done: i.status === "done",
    label: itemLabel(i, c, meetings), title: clip(i.text, 140), href: `/item/${encodeURIComponent(i.id)}`,
    ...extra,
  };
}

const KIND_ORDER = { decision: 0, owe: 1, waiting: 2 } as const;
const live = (i: Item) => i.status === "open" || i.status === "done";

function bounds(nodes: CanvasNode[]): number {
  return Math.max(0, ...nodes.map((n) => n.y + (n.h ?? cardHeight(n))));
}

/** People row under a set of item cards: the most named people, each linked to their cards. */
function peopleRow(cards: Array<{ node: CanvasNode; item: Item }>, c: Ctx, y: number, maxW: number): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const count = new Map<string, Array<string>>();
  for (const { node, item } of cards) {
    const p = item.person?.trim();
    if (!p || isSpeakerLabel(p) || isSelf(p, c.self) || item.status !== "open") continue;
    (count.get(p) ?? count.set(p, []).get(p)!).push(node.id);
  }
  const top = [...count].sort((a, b) => b[1].length - a[1].length).slice(0, 5);
  const step = Math.max(150, Math.floor(maxW / Math.max(1, top.length)));
  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];
  top.forEach(([name, ids], k) => {
    const id = `person:${name.toLowerCase()}`;
    nodes.push({ id, kind: "person", x: TOP + k * step, y, w: Math.min(240, 56 + name.length * 9), label: "", title: name, href: `/people/${encodeURIComponent(name.toLowerCase().replace(/\s+/g, "-"))}` });
    for (const from of ids.slice(0, 3)) edges.push({ from, to: id, kind: "soft" });
  });
  return { nodes, edges };
}

// ---------- 1. Project map ----------

export function buildMap(topic: string, c: Ctx): CanvasDoc {
  const all = meetingsAbout(topic, c.meetings, c.items);
  const shown = all.slice(-MAP_MAX_MEETINGS);
  const byId = new Map(c.meetings.map((m) => [m.id, m]));
  const byMeeting = groupItems(c.items);
  const shownIds = new Set(shown.map((m) => m.id));
  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];
  const cards: Array<{ node: CanvasNode; item: Item }> = [];
  shown.forEach((m, col) => {
    const x = TOP + col * (COL_W + GAP_X);
    const mn = meetingNode(m, c, x, TOP);
    nodes.push(mn);
    const its = (byMeeting.get(m.id) ?? []).filter(live)
      .map((i) => ({ i, s: (mentions(i.text, topic) ? 4 : 0) + (i.status === "open" ? 2 : 0) + (i.kind === "decision" ? 1 : 0) }))
      .sort((a, b) => b.s - a.s || KIND_ORDER[a.i.kind] - KIND_ORDER[b.i.kind]);
    const pick = its.slice(0, PER_COLUMN).map((x) => x.i).sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
    let y = TOP + cardHeight(mn) + 46;
    for (const i of pick) {
      const n = itemNode(i, c, byId, x, y, COL_W, { stack: `col${col}` });
      nodes.push(n);
      cards.push({ node: n, item: i });
      edges.push({ from: mn.id, to: n.id, kind: "from" });
      y += cardHeight(n) + GAP_Y;
    }
    if (its.length > pick.length) {
      const more: CanvasNode = { id: `more:${m.id}`, kind: "more", x, y, w: COL_W, stack: `col${col}`, label: "", title: `${its.length - pick.length} more from this meeting`, href: `/meeting/${encodeURIComponent(m.id)}` };
      nodes.push(more);
    }
  });
  // A later meeting on the map that closed an item: a heavy dashed line from it.
  for (const { node, item } of cards) {
    if (item.closedByMeetingId && item.closedByMeetingId !== item.meetingId && shownIds.has(item.closedByMeetingId))
      edges.push({ from: `meeting:${item.closedByMeetingId}`, to: node.id, kind: "close" });
  }
  const ppl = peopleRow(cards, c, bounds(nodes) + 70, shown.length * (COL_W + GAP_X));
  nodes.push(...ppl.nodes);
  edges.push(...ppl.edges);
  const first = shown[0], last = shown[shown.length - 1];
  return {
    id: `map:${topic}`, title: sentence(topic),
    meta: shown.length
      ? `Built from ${all.length} meeting${all.length === 1 ? "" : "s"}, ${short(first.startedAt, c.timeZone)} to ${short(last.startedAt, c.timeZone)}${all.length > shown.length ? ` · the latest ${shown.length} shown` : ""}`
      : "",
    nodes, edges,
    empty: shown.length ? undefined : `No meetings about “${topic}” yet.`,
  };
}

// ---------- 2. Meeting prep ----------

export interface PrepTarget {
  /** "map", "slot:11:00", "person:riya". */
  key: string;
  title: string;
  /** When it starts, ISO, or null for a person (no date). */
  at: string | null;
  /** Earlier meetings to read, newest first. */
  meetings: Meeting[];
  /** Names whose open items belong in the prep. */
  people: string[];
}

export const PREP_MEETINGS = 3;
export const PREP_ITEMS = 6;

export function prepItems(t: PrepTarget, c: Ctx): Item[] {
  const ids = new Set(t.meetings.map((m) => m.id));
  const names = t.people.map((p) => p.toLowerCase());
  return c.items
    .filter((i) => i.status === "open" && i.kind !== "decision")
    .filter((i) => ids.has(i.meetingId) || (i.person && names.some((n) => i.person!.toLowerCase() === n || i.person!.toLowerCase().split(/\s+/)[0] === n)))
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999") || b.createdAt.localeCompare(a.createdAt))
    .slice(0, PREP_ITEMS);
}

export function buildPrep(t: PrepTarget, c: Ctx): CanvasDoc {
  const byId = new Map(c.meetings.map((m) => [m.id, m]));
  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];
  const leftW = 250, midX = TOP + leftW + 70, midW = 470, rightX = midX + midW + 70, rightW = 260;
  t.meetings.slice(0, PREP_MEETINGS).forEach((m) => {
    nodes.push({ ...meetingNode(m, c, TOP, TOP, leftW), stack: "left" });
  });
  const target: CanvasNode = {
    id: "target", kind: "meeting", x: midX, y: TOP, w: midW,
    label: t.at ? `Next · ${weekday(t.at, c.timeZone)} ${short(t.at, c.timeZone)}, ${clock(t.at, c.timeZone)}` : "Prep",
    title: sentence(t.title), sub: t.people.length ? t.people.slice(0, 4).join(", ") : undefined,
  };
  nodes.push(target);
  const ask: CanvasNode = { id: "ask", kind: "ask", x: midX, y: TOP + cardHeight(target) + 50, w: midW, label: "Ask · only what’s on this canvas", sub: t.at ? `I'm preparing for ${t.title}, on ${weekday(t.at, c.timeZone)} at ${clock(t.at, c.timeZone)}` : `I'm preparing to talk to ${t.title}`, title: t.at ? `What should I raise in ${t.title}?` : `What’s open between me and ${t.title}?` };
  nodes.push(ask);
  edges.push({ from: "target", to: "ask", kind: "soft" });
  for (const i of prepItems(t, c)) nodes.push(itemNode(i, c, byId, rightX, TOP, rightW, { stack: "right" }));
  for (const n of nodes) if (n.context) edges.push({ from: n.id, to: "ask", kind: "ctx" });
  const ctxCount = nodes.filter((n) => n.context).length;
  return {
    id: `prep:${t.key}`, title: `Prep for ${t.title}`,
    meta: `${t.meetings.length ? `${Math.min(PREP_MEETINGS, t.meetings.length)} meetings` : "No earlier meetings"} · ${ctxCount} things in context`,
    nodes, edges,
    empty: ctxCount ? undefined : "Nothing recorded with them yet.",
  };
}

// ---------- 3. Start in a new window ----------

export function buildStart(item: Item, windows: CanvasWindow[], c: Ctx): CanvasDoc {
  const byId = new Map(c.meetings.map((m) => [m.id, m]));
  const m = byId.get(item.meetingId) ?? null;
  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];
  const leftW = 280, midX = TOP + leftW + 90, midW = 460, rightX = midX + midW + 60;
  nodes.push(itemNode(item, c, byId, TOP, TOP, leftW, { stack: "left", context: false }));
  if (item.quote && item.quote.trim().toLowerCase() !== item.text.trim().toLowerCase()) nodes.push({ id: "quote", kind: "quote", x: TOP, y: TOP, w: leftW, stack: "left", label: "Their words", title: `“${clip(item.quote, 220)}”`, sub: m ? `${m.title}, ${short(m.startedAt, c.timeZone)}` : undefined });
  if (m) nodes.push({ ...meetingNode(m, c, TOP, TOP, leftW), stack: "left" });
  const sameMeeting = c.items.filter((i) => i.meetingId === item.meetingId && i.id !== item.id && i.kind === "decision" && live(i)).slice(0, 2);
  const who = item.person?.toLowerCase().split(/\s+/)[0];
  const samePerson = who ? c.items.filter((i) => i.id !== item.id && i.status === "open" && i.kind !== "decision" && i.person?.toLowerCase().split(/\s+/)[0] === who).slice(0, 3) : [];
  for (const i of [...sameMeeting, ...samePerson]) nodes.push(itemNode(i, c, byId, TOP, TOP, leftW, { stack: "left" }));
  nodes.push({ id: "launch", kind: "window", x: midX, y: TOP, w: midW, stack: "mid", itemId: item.id, label: "New window", title: "Start this with the context on the left" });
  for (const w of windows) nodes.push({ id: `window:${w.id}`, kind: "window", x: midX, y: TOP, w: midW, stack: "mid", itemId: item.id, label: w.kind, title: w.title });
  nodes.push({
    id: "linked", kind: "more", x: rightX, y: TOP, w: 230, label: "Linked to the item",
    title: item.status === "done" ? "Done. This item is closed." : "Mark a window done to close the item",
    sub: "A later meeting that says it’s done closes it too",
  });
  const first = nodes.find((n) => n.id === `item:${item.id}`)!;
  for (const n of nodes) if (n.stack === "left") edges.push({ from: n.id, to: "launch", kind: "ctx" });
  for (const w of windows) edges.push({ from: first.id, to: `window:${w.id}`, kind: "soft" });
  return {
    id: `start:${item.id}`, title: clip(item.text, 80),
    meta: `${nodes.filter((n) => n.stack === "left").length} sources · ${windows.filter((w) => w.status !== "done").length} window${windows.length === 1 ? "" : "s"} open`,
    nodes, edges,
  };
}

/** What the new window reads: the item, its words, the meeting, and what's related. Plain text. */
export function startContext(item: Item, c: Ctx, userName: string): string {
  const byId = new Map(c.meetings.map((m) => [m.id, m]));
  const m = byId.get(item.meetingId);
  const lines = [`I'm ${userName}. This came out of one of my meetings and I want to get it done.`, ""];
  lines.push(`${item.kind === "owe" ? "What I owe" : item.kind === "waiting" ? "What I'm waiting on" : "Decision"}: ${item.text}`);
  if (item.person && !isSpeakerLabel(item.person)) lines.push(`${item.kind === "owe" ? "Owed to" : "From"}: ${item.person}`);
  if (item.dueAt) lines.push(`Due: ${short(item.dueAt, c.timeZone)}`);
  if (m) lines.push(`Meeting: ${m.title}, ${short(m.startedAt, c.timeZone)}${others(m, c.self).length ? ` (with ${others(m, c.self).slice(0, 5).join(", ")})` : ""}`);
  if (item.quote) lines.push(`Exact words: "${item.quote}"`);
  const dec = c.items.filter((i) => i.meetingId === item.meetingId && i.kind === "decision" && live(i) && i.id !== item.id).slice(0, 4);
  if (dec.length) { lines.push("", "Decided in that meeting:"); for (const d of dec) lines.push(`- ${d.text}`); }
  const who = item.person?.toLowerCase().split(/\s+/)[0];
  const rel = who ? c.items.filter((i) => i.id !== item.id && i.status === "open" && i.kind !== "decision" && i.person?.toLowerCase().split(/\s+/)[0] === who).slice(0, 4) : [];
  if (rel.length) { lines.push("", `Other open items with ${item.person}:`); for (const r of rel) lines.push(`- ${r.kind === "owe" ? "I owe" : "Waiting on them"}: ${r.text}`); }
  return lines.join("\n");
}

// ---------- 4. Combine threads ----------

/** Open owe / waiting items from a meeting that share a content word with a decision. */
function tiedTo(decision: Item, c: Ctx, max = 2): Item[] {
  const ws = new Set(words(decision.text));
  return c.items
    .filter((i) => i.meetingId === decision.meetingId && i.id !== decision.id && i.status === "open" && i.kind !== "decision")
    .filter((i) => words(i.text).some((w) => ws.has(w)))
    .slice(0, max);
}

export function buildConflict(conflict: { id: string; note: string; oldId: string; newId: string }, c: Ctx): CanvasDoc | null {
  const byId = new Map(c.meetings.map((m) => [m.id, m]));
  const oldI = c.items.find((i) => i.id === conflict.oldId), newI = c.items.find((i) => i.id === conflict.newId);
  if (!oldI || !newI) return null;
  const mOld = byId.get(oldI.meetingId), mNew = byId.get(newI.meetingId);
  const sideW = 290, midW = 360, midX = TOP + sideW + 70, rightX = midX + midW + 70;
  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];
  if (mOld) nodes.push({ ...meetingNode(mOld, c, TOP, TOP, sideW), stack: "left" });
  nodes.push(itemNode(oldI, c, byId, TOP, TOP, sideW, { stack: "left", label: `Decision · ${mOld ? short(mOld.startedAt, c.timeZone) : "earlier"}`, quote: clip(oldI.quote, 160) }));
  if (mNew) nodes.push({ ...meetingNode(mNew, c, rightX, TOP, sideW), stack: "right" });
  nodes.push(itemNode(newI, c, byId, rightX, TOP, sideW, { stack: "right", label: `Decision · ${mNew ? short(mNew.startedAt, c.timeZone) : "later"}`, quote: clip(newI.quote, 160) }));
  const pa = new Set(mOld ? others(mOld, c.self) : []), pb = mNew ? others(mNew, c.self) : [];
  const onlyNew = pb.filter((p) => !pa.has(p)), both = pb.filter((p) => pa.has(p));
  const who = [both.length ? `${both.slice(0, 3).join(", ")} ${both.length === 1 ? "was" : "were"} in both meetings.` : "", onlyNew.length ? `${onlyNew.slice(0, 3).join(", ")} only in the later one.` : ""].filter(Boolean).join(" ");
  const actions: NodeAction[] = [
    { type: "resolve", contradictionId: conflict.id, how: "replace", label: "Use the newer one" },
    { type: "resolve", contradictionId: conflict.id, how: "keep", label: "Keep both" },
  ];
  nodes.push({ id: "conflict", kind: "conflict", x: midX, y: TOP + 60, w: midW, label: "These two disagree", title: sentence(conflict.note), sub: who || undefined, actions });
  edges.push({ from: `item:${oldI.id}`, to: "conflict", kind: "conflict" }, { from: `item:${newI.id}`, to: "conflict", kind: "conflict" });
  if (mOld) edges.push({ from: `meeting:${mOld.id}`, to: `item:${oldI.id}`, kind: "from" });
  if (mNew) edges.push({ from: `meeting:${mNew.id}`, to: `item:${newI.id}`, kind: "from" });
  for (const [d, x, st] of [[oldI, TOP, "left"], [newI, rightX, "right"]] as const) {
    for (const t of tiedTo(d, c)) {
      nodes.push(itemNode(t, c, byId, x, TOP, sideW, { stack: st }));
      edges.push({ from: `item:${d.id}`, to: `item:${t.id}`, kind: "soft" });
    }
  }
  return { id: `combine:${conflict.id}`, title: clip(sentence(conflict.note), 70), meta: `2 meetings disagree${mNew ? ` · found after ${short(mNew.startedAt, c.timeZone)}` : ""}`, nodes, edges };
}

export function buildCombine(a: Meeting, b: Meeting, c: Ctx): CanvasDoc {
  const [m1, m2] = a.startedAt <= b.startedAt ? [a, b] : [b, a];
  const byId = new Map(c.meetings.map((m) => [m.id, m]));
  const byMeeting = groupItems(c.items);
  const sideW = 290, midW = 330, midX = TOP + sideW + 70, rightX = midX + midW + 70;
  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];
  const side = (m: Meeting, x: number, st: string) => {
    nodes.push({ ...meetingNode(m, c, x, TOP, sideW), stack: st });
    const its = (byMeeting.get(m.id) ?? []).filter(live).sort((p, q) => KIND_ORDER[p.kind] - KIND_ORDER[q.kind]).slice(0, 6);
    for (const i of its) {
      nodes.push(itemNode(i, c, byId, x, TOP, sideW, { stack: st }));
      edges.push({ from: `meeting:${m.id}`, to: `item:${i.id}`, kind: "from" });
    }
    return its;
  };
  const i1 = side(m1, TOP, "left"), i2 = side(m2, rightX, "right");
  const p1 = new Set(others(m1, c.self)), shared = others(m2, c.self).filter((p) => p1.has(p));
  const w1 = new Set([m1.title, ...i1.map((i) => i.text)].flatMap(words));
  const sharedWords = [...new Set([m2.title, ...i2.map((i) => i.text)].flatMap(words))].filter((w) => w1.has(w)).slice(0, 6);
  nodes.push({
    id: "both", kind: "conflict", x: midX, y: TOP + 40, w: midW, tone: "",
    label: "In both", title: sharedWords.length ? sharedWords.join(", ") : "No shared topics",
    sub: shared.length ? `People in both: ${shared.slice(0, 4).join(", ")}` : "No one was in both meetings",
  });
  // Lines between items of the two meetings that talk about the same thing.
  for (const x of i1) for (const y of i2) {
    const wx = new Set(words(x.text));
    if (words(y.text).filter((w) => wx.has(w)).length >= 2) edges.push({ from: `item:${x.id}`, to: `item:${y.id}`, kind: x.kind === "decision" && y.kind === "decision" ? "conflict" : "soft" });
  }
  return { id: `combine:${m1.id}:${m2.id}`, title: `${clip(m1.title, 32)} + ${clip(m2.title, 32)}`, meta: `${short(m1.startedAt, c.timeZone)} and ${short(m2.startedAt, c.timeZone)}`, nodes, edges };
}

// ---------- 5. Friday review ----------

/** Monday of the week holding `date` (YYYY-MM-DD). */
export function mondayOf(date: string): string {
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
  return addDays(date, -((dow + 6) % 7));
}

export const WEEK_ZONE = 340;

export function buildWeek(monday: string, c: Ctx): CanvasDoc {
  const tz = c.timeZone;
  const start = zonedTime(monday, "00:00", tz).toISOString();
  const end = zonedTime(addDays(monday, 7), "00:00", tz).toISOString();
  const nextEnd = zonedTime(addDays(monday, 14), "00:00", tz).toISOString();
  const inWeek = (iso: string | null | undefined) => !!iso && iso >= start && iso < end;
  const byId = new Map(c.meetings.map((m) => [m.id, m]));
  const weekMeetings = c.meetings.filter((m) => !m.duplicateOf && inWeek(m.startedAt));
  const weekIds = new Set(weekMeetings.map((m) => m.id));
  const nowIso = c.now.toISOString();
  const snoozedNext = (i: Item) => !!i.snoozedUntil && i.snoozedUntil >= end && i.snoozedUntil < nextEnd;

  const decided = c.items.filter((i) => i.kind === "decision" && live(i) && weekIds.has(i.meetingId));
  const open = c.items.filter((i) => i.status === "open" && i.kind !== "decision" && weekIds.has(i.meetingId) && !snoozedNext(i))
    .sort((a, b) => (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999"));
  const closed = c.items.filter((i) => i.status === "done" && i.kind !== "decision" && inWeek(i.closedAt));
  const stuck = c.items
    .filter((i) => i.status === "open" && i.kind !== "decision" && !weekIds.has(i.meetingId) && !snoozedNext(i))
    .filter((i) => !(i.snoozedUntil && i.snoozedUntil > nowIso))
    .filter((i) => Date.parse(byId.get(i.meetingId)?.startedAt ?? i.createdAt) < c.now.getTime() - 7 * DAY)
    .sort((a, b) => (byId.get(a.meetingId)?.startedAt ?? a.createdAt).localeCompare(byId.get(b.meetingId)?.startedAt ?? b.createdAt));
  const next = c.items.filter((i) => i.status === "open" && snoozedNext(i));

  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];
  // Day ribbon.
  const dayW = Math.floor((4 * (WEEK_ZONE + 20) - 20 - 4 * 12) / 5);
  for (let d = 0; d < 5; d++) {
    const date = addDays(monday, d);
    const ms = weekMeetings.filter((m) => localDate(new Date(m.startedAt), tz) === date);
    const n = c.items.filter((i) => i.kind !== "decision" && ms.some((m) => m.id === i.meetingId)).length;
    nodes.push({
      id: `day:${date}`, kind: "day", x: TOP + d * (dayW + 12), y: TOP, w: dayW,
      label: new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }),
      title: ms.length ? `${ms.length} meeting${ms.length === 1 ? "" : "s"}${n ? ` · ${n} item${n === 1 ? "" : "s"}` : ""}` : "No meetings",
      href: `/day/${date}`,
    });
  }
  const zoneTop = TOP + 90;
  const col = (k: number) => TOP + k * (WEEK_ZONE + 20);
  const zones: Array<{ id: string; title: string; tone: "hi" | "red" | ""; items: Item[]; max: number; drop?: "next-week"; act: (i: Item) => NodeAction[] }> = [
    { id: "decided", title: `Decided this week · ${decided.length}`, tone: "hi", items: decided, max: 6, act: () => [] },
    { id: "open", title: `Still open from this week · ${open.length}`, tone: "", items: open, max: 6, act: (i) => [{ type: "next-week", itemId: i.id, label: "Next week" }, { type: "done", itemId: i.id, label: "Done" }] },
    { id: "stuck", title: `Stuck over 7 days · ${stuck.length}`, tone: "red", items: stuck, max: 5, act: (i) => [{ type: "link", href: `/canvas/start/${encodeURIComponent(i.id)}`, label: "Start this" }, { type: "done", itemId: i.id, label: "Done" }] },
    { id: "next", title: `Next week · ${next.length}`, tone: "hi", items: next, max: 6, drop: "next-week", act: () => [] },
  ];
  zones.forEach((z, k) => {
    const x = col(k);
    const cards = z.items.slice(0, z.max).map((i) => itemNode(i, c, byId, x + 16, zoneTop + 44, WEEK_ZONE - 32, { stack: z.id, actions: z.act(i), draggable: z.id !== "decided" && z.id !== "next" }));
    const h = Math.max(z.id === "next" ? 200 : 140, 60 + cards.reduce((s, n) => s + cardHeight(n) + GAP_Y, 0));
    nodes.push({ id: `zone:${z.id}`, kind: "zone", x, y: zoneTop, w: WEEK_ZONE, h, tone: z.tone, label: "", title: z.items.length > z.max ? `${z.title} (${z.max} shown)` : z.title, holds: z.id, drop: z.drop,
      sub: z.id === "next" && !cards.length ? "Drag a card here to move it to next week" : undefined });
    nodes.push(...cards);
  });
  const closedNote = closed.length ? ` · ${closed.length} closed` : "";
  return {
    id: `week:${monday}`, title: `Week of ${new Date(`${monday}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })}`,
    meta: `${weekMeetings.length} meeting${weekMeetings.length === 1 ? "" : "s"} · ${decided.length} decided · ${open.length} open${closedNote} · ${stuck.length} stuck`,
    nodes, edges,
  };
}
