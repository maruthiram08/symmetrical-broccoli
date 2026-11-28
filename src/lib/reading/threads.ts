// Threads found across meetings: meetings that share a distinctive phrase ("stock split", "chart
// alerts"), the people on their items, and closures (a later meeting closing an earlier item).
// Pure: it reads what it is given and writes nothing. A found thread is a suggestion only. It never
// files an item or sets `project`; only Keep (thread-actions.ts) does, when you press it.
import { localDate } from "@/lib/brief/time";
import type { Item, Meeting } from "@/lib/types";

export const MIN_MEETINGS = 4;
export const MIN_PEOPLE = 2;
/** Open items and no new item for this many days: Stalled. */
export const STALL_DAYS = 10;
const DAY = 86_400_000;

// Function words and the verbs every promise starts with. Pairs are what make a phrase distinctive,
// so a generic word ("option", "chart") is fine inside a pair and never a phrase on its own.
const STOP = new Set((
  "a an the and or but if then than so to of in on at by for from with without into onto over under about as is are was were be been being " +
  "it its this that these those there here we our you your they their them he she his her i me my us not no yes do does did done doing " +
  "will would can could should may might must shall have has had get gets got make makes made let lets via per each every all any some more most " +
  "other others same such only also just very really still again new next last first today tomorrow yesterday week weeks day days month time " +
  "share send check review update discuss discussed follow up confirm ask tell explain explore look find work working add added create set " +
  "fix call meeting meetings sync team plan planning progress status task tasks ticket tickets item items thing things point points note notes " +
  "front end back including include beyond using based like along regarding related "+
  "whether what when where which who why how before after during between around within across up down out off one two three"
).split(" "));

const stem = (w: string) => (w.length > 4 && w.endsWith("ies") ? `${w.slice(0, -3)}y` : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);

/** Two-word phrases in a text, stemmed: "Chart alerts for RSI" → ["chart alert", "alert rsi"]. Keyed by stem, with the words as written. */
export function phrasesOf(text: string, skip: Set<string> = new Set()): Map<string, string> {
  const words = text.toLowerCase().replace(/[’']/g, "").split(/[^a-z0-9]+/).filter(Boolean);
  const out = new Map<string, string>();
  for (let k = 0; k + 1 < words.length; k++) {
    const a = words[k], b = words[k + 1];
    if (STOP.has(a) || STOP.has(b) || skip.has(a) || skip.has(b) || a.length < 3 || b.length < 3 || /^\d+$/.test(a) || /^\d+$/.test(b)) continue;
    const key = `${stem(a)} ${stem(b)}`;
    if (!out.has(key)) out.set(key, `${a} ${b}`);
  }
  return out;
}

export type ThreadState = "moving" | "stalled" | "wrapped";

export interface FoundThread {
  /** Stable while the thread's name stays: "t-chart-alerts". */
  id: string;
  name: string;
  /** Oldest first. */
  meetings: Meeting[];
  /** Every live item from those meetings. */
  items: Item[];
  open: Item[];
  decisions: Item[];
  kept: number;
  /** People on its items, most items first. */
  people: Array<{ name: string; items: number; open: number }>;
  /** The phrases that tie it together, strongest first. */
  phrases: string[];
  /** Items from one meeting that a later meeting in the thread closed. */
  closures: Item[];
  state: ThreadState;
  /** Local date of its newest meeting. */
  last: string;
  /** Local date of its newest item, for Stalled. */
  lastItem: string;
  /** A short fingerprint: changes when an item is added or changes status. */
  signature: string;
}

export interface ThreadInput {
  items: Item[];
  meetings: Meeting[];
  now: Date;
  timeZone: string;
  /** The name an item's person resolves to (directory and aliases), or null for nobody. */
  personOf: (i: Item) => string | null;
  /** Words never part of a phrase: people's names, your own name. */
  nameWords?: Iterable<string>;
  /** Thread ids you said are not one thread. */
  dismissed?: Iterable<string>;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
const jaccard = (a: Set<string>, b: Set<string>) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n / (a.size + b.size - n || 1); };

/** Threads across meetings, most open first. Threads mostly filed to one of your projects are left out (they're yours already). */
export function findThreads(input: ThreadInput): FoundThread[] {
  const { now, timeZone: tz, personOf } = input;
  const meetings = input.meetings.filter((m) => !m.duplicateOf);
  const byId = new Map(meetings.map((m) => [m.id, m]));
  const live = input.items.filter((i) => i.status !== "wrong" && i.status !== "inbox" && byId.has(i.meetingId));
  const skip = new Set([...(input.nameWords ?? [])].flatMap((n) => n.toLowerCase().split(/[^a-z0-9]+/)).filter((w) => w.length > 2));
  const dismissed = new Set(input.dismissed ?? []);

  // Each meeting's phrases (its title counts twice), and how many meetings each phrase is in.
  const itemsOf = new Map<string, Item[]>();
  for (const i of live) itemsOf.set(i.meetingId, [...(itemsOf.get(i.meetingId) ?? []), i]);
  const weight = new Map<string, Map<string, number>>(); // meeting -> phrase -> weight
  const surface = new Map<string, Map<string, number>>(); // phrase -> written form -> count
  for (const m of meetings) {
    const w = new Map<string, number>();
    const add = (text: string, n: number) => {
      for (const [k, s] of phrasesOf(text, skip)) {
        w.set(k, (w.get(k) ?? 0) + n);
        const f = surface.get(k) ?? new Map<string, number>();
        f.set(s, (f.get(s) ?? 0) + 1);
        surface.set(k, f);
      }
    };
    add(m.title ?? "", 2);
    for (const i of itemsOf.get(m.id) ?? []) add(i.text, 1);
    if (w.size) weight.set(m.id, w);
  }
  const df = new Map<string, Set<string>>();
  for (const [mid, w] of weight) for (const k of w.keys()) df.set(k, (df.get(k) ?? new Set()).add(mid));
  const ceiling = Math.max(MIN_MEETINGS, Math.round(meetings.length * 0.4));
  const candidates = [...df].filter(([, ms]) => ms.size >= 3 && ms.size <= ceiling).sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]));

  // Phrases whose meetings mostly overlap are one topic.
  const clusters: Array<{ phrases: string[]; meetings: Set<string> }> = [];
  for (const [k, ms] of candidates) {
    const hit = clusters.find((c) => jaccard(c.meetings, ms) >= 0.4);
    if (hit) { hit.phrases.push(k); for (const m of ms) hit.meetings.add(m); } else clusters.push({ phrases: [k], meetings: new Set(ms) });
  }

  // Each meeting joins the one cluster it says the most about, so its items go to one thread.
  const owner = new Map<string, number>();
  for (const [mid, w] of weight) {
    let best = -1, bestScore = 0;
    clusters.forEach((c, n) => {
      const score = c.phrases.reduce((s, k) => s + (w.get(k) ?? 0), 0);
      if (score > bestScore || (score === bestScore && score > 0 && c.meetings.size > clusters[best].meetings.size)) { best = n; bestScore = score; }
    });
    if (best >= 0) owner.set(mid, best);
  }
  // A later meeting that closed one of a thread's items belongs to it, unless it already has a thread.
  for (const i of live) {
    if (!i.closedByMeetingId || !byId.has(i.closedByMeetingId) || owner.has(i.closedByMeetingId)) continue;
    const c = owner.get(i.meetingId);
    if (c !== undefined) owner.set(i.closedByMeetingId, c);
  }

  const out: FoundThread[] = [];
  clusters.forEach((c, n) => {
    const ms = meetings.filter((m) => owner.get(m.id) === n).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    if (ms.length < MIN_MEETINGS) return;
    const ids = new Set(ms.map((m) => m.id));
    const items = live.filter((i) => ids.has(i.meetingId));
    const counts = new Map<string, { name: string; items: number; open: number }>();
    for (const i of items) {
      const p = personOf(i);
      if (!p) continue;
      const e = counts.get(p) ?? { name: p, items: 0, open: 0 };
      e.items++;
      if (i.status === "open" && i.kind !== "decision") e.open++;
      counts.set(p, e);
    }
    const people = [...counts.values()].sort((a, b) => b.items - a.items || a.name.localeCompare(b.name));
    if (people.length < MIN_PEOPLE) return;
    // Mostly filed to one project already: that project is the thread.
    const filed = new Map<string, number>();
    for (const i of items) if (i.project) filed.set(i.project, (filed.get(i.project) ?? 0) + 1);
    if ([...filed.values()].some((v) => v >= items.length * 0.6)) return;

    // Name it from its strongest phrase: in the most of its meetings.
    const inThread = c.phrases.map((k) => [k, ms.filter((m) => weight.get(m.id)?.has(k)).length * 100 + ms.reduce((s, m) => s + (weight.get(m.id)?.get(k) ?? 0), 0)] as const).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    const top = inThread[0]?.[0];
    if (!top) return;
    const written = [...(surface.get(top) ?? new Map())].sort((a, b) => b[1] - a[1])[0]?.[0] ?? top;
    const name = written.replace(/^./, (x: string) => x.toUpperCase());
    const id = `t-${slug(name)}`;
    if (dismissed.has(id) || out.some((t) => t.id === id)) return;

    const open = items.filter((i) => i.status === "open" && i.kind !== "decision");
    const day = (iso: string) => localDate(new Date(iso), tz);
    const said = (i: Item) => byId.get(i.meetingId)!.startedAt;
    const last = day(ms[ms.length - 1].startedAt);
    const lastItem = day(items.map(said).sort().pop() ?? ms[ms.length - 1].startedAt);
    const quiet = (Date.parse(`${day(now.toISOString())}T12:00:00Z`) - Date.parse(`${lastItem}T12:00:00Z`)) / DAY;
    const state: ThreadState = !open.length ? "wrapped" : quiet >= STALL_DAYS ? "stalled" : "moving";
    out.push({
      id, name, meetings: ms, items, open,
      decisions: items.filter((i) => i.kind === "decision").sort((a, b) => said(a).localeCompare(said(b))),
      kept: items.filter((i) => i.status === "done").length,
      people,
      phrases: inThread.slice(0, 4).map(([k]) => [...(surface.get(k) ?? new Map())].sort((a, b) => b[1] - a[1])[0]?.[0] ?? k),
      closures: items.filter((i) => i.closedByMeetingId && ids.has(i.closedByMeetingId) && i.closedByMeetingId !== i.meetingId),
      state, last, lastItem,
      signature: signatureOf(items),
    });
  });
  return out.sort((a, b) => b.open.length - a.open.length || b.meetings.length - a.meetings.length || a.name.localeCompare(b.name));
}

/** Changes when an item joins, leaves or changes status. */
export function signatureOf(items: Item[]): string {
  const s = items.map((i) => `${i.id}:${i.status}`).sort().join("|");
  let h = 5381;
  for (let k = 0; k < s.length; k++) h = ((h << 5) + h + s.charCodeAt(k)) | 0;
  return `${items.length}-${(h >>> 0).toString(36)}`;
}

export type TrailTag = { kind: "first" } | { kind: "changes"; of: string } | { kind: "adds" } | { kind: "now" };
export interface TrailStep { item: Item; tag: TrailTag; /** A later decision changed it. */ old: boolean }

/**
 * How the decisions moved, oldest first: the first call, ones that change an earlier one (from the
 * changed-decision check), ones that add to it, and the latest one still standing. `changes` are
 * stored contradiction pairs; a pair you marked "kept" (both stand) doesn't count.
 */
export function decisionTrail(decisions: Item[], changes: Array<{ newId: string; oldId: string; status?: string }>, saidAt: (i: Item) => string): TrailStep[] {
  const ds = [...decisions].sort((a, b) => saidAt(a).localeCompare(saidAt(b)));
  const ids = new Set(ds.map((d) => d.id));
  const pairs = changes.filter((c) => c.status !== "kept" && ids.has(c.newId) && ids.has(c.oldId));
  const overridden = new Set(pairs.map((c) => c.oldId));
  const standing = ds.filter((d) => !overridden.has(d.id));
  const now = standing[standing.length - 1]?.id;
  return ds.map((d, n) => {
    const ch = pairs.find((c) => c.newId === d.id);
    const old = overridden.has(d.id);
    const tag: TrailTag = d.id === now && n > 0 ? { kind: "now" } : n === 0 ? { kind: "first" } : ch ? { kind: "changes", of: saidAt(ds.find((x) => x.id === ch.oldId)!) } : { kind: "adds" };
    return { item: d, tag, old };
  });
}

/** "Where it stands" without AI: built from the thread itself. */
export function standsTemplate(t: FoundThread, saidAt: (i: Item) => string): string {
  const trail = decisionTrail(t.decisions, [], saidAt);
  const latest = trail.length ? trail[trail.length - 1].item.text.replace(/\.$/, "") : null;
  const parts = [
    `${t.meetings.length} meetings with ${t.people.slice(0, 3).map((p) => p.name).join(", ")}${t.people.length > 3 ? ` and ${t.people.length - 3} more` : ""}.`,
    latest ? `The latest call: ${latest}.` : "Nothing was decided yet.",
    t.kept ? `${t.kept} ${t.kept === 1 ? "promise is" : "promises are"} kept.` : "",
    t.open.length ? `${t.open.length} still open, the oldest: ${t.open[0].text.replace(/\.$/, "")}.` : "Nothing is open.",
  ];
  return parts.filter(Boolean).join(" ");
}

/** The plain-text status Copy status puts on the clipboard. */
export function statusText(t: FoundThread, stands: string, saidAt: (i: Item) => string, tz: string): string {
  const d = (i: Item) => new Date(saidAt(i)).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: tz });
  const trail = decisionTrail(t.decisions, [], saidAt).filter((s) => !s.old).slice(-3);
  return [
    `${t.name}: ${t.state === "stalled" ? "stalled" : t.state === "wrapped" ? "wrapped up" : "moving"}`,
    stands,
    trail.length ? `\nDecided:\n${trail.map((s) => `• ${s.item.text} (${d(s.item)})`).join("\n")}` : "",
    t.open.length ? `\nStill open:\n${t.open.map((i) => `• ${i.text}${i.person ? ` (${i.person})` : ""}`).join("\n")}` : "",
  ].filter(Boolean).join("\n");
}
