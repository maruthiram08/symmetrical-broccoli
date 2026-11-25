// People: everyone named as item.person, with obvious spelling variants merged.
// Pure functions; the pages load items and meetings and pass them in.

import type { Item, Meeting } from "@/lib/types";

/** "  Nitin  K. " -> "nitin k". Lowercase, punctuation to spaces, collapsed. */
export function normalizeName(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** URL segment for a name: "Nitin K" -> "nitin-k". */
export function personSlug(name: string): string {
  return normalizeName(name).replace(/[\s']+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

const tokens = (key: string) => key.split(" ").filter(Boolean);

/**
 * Two multi-word names are the same person when the first words match and every later word
 * is a prefix of the other ("Nitin K" and "Nitin Kumar"; not "Nitin Rao" and "Nitin Kumar").
 */
function compatible(a: string[], b: string[]): boolean {
  if (a[0] !== b[0]) return false;
  for (let i = 1; i < Math.min(a.length, b.length); i++) {
    if (!a[i].startsWith(b[i]) && !b[i].startsWith(a[i])) return false;
  }
  return true;
}

export interface PersonGroup {
  /** The spelling shown: the most used one, the longer on a tie. */
  name: string;
  slug: string;
  /** Normalized spellings that belong to this person. */
  keys: string[];
  /** Every spelling seen, as written, most used first. */
  spellings: string[];
}

/**
 * Group raw names into people. Exact matches merge after normalizing; a one-word name
 * ("Nitin") joins a longer one ("Nitin K") only when exactly one person has that first name.
 * Names in `exclude` (the user and their aliases) are left out.
 */
export function groupNames(names: Iterable<string>, exclude: Iterable<string> = []): PersonGroup[] {
  const skip = new Set([...exclude].map(normalizeName).filter(Boolean));
  const spellings = new Map<string, Map<string, number>>(); // key -> raw spelling -> count
  for (const raw of names) {
    const shown = raw.trim().replace(/\s+/g, " ");
    const key = normalizeName(shown);
    if (!key || skip.has(key)) continue;
    const m = spellings.get(key) ?? new Map<string, number>();
    m.set(shown, (m.get(shown) ?? 0) + 1);
    spellings.set(key, m);
  }

  // Union-find over multi-word keys, then attach single words.
  const keys = [...spellings.keys()];
  const parent = new Map(keys.map((k) => [k, k]));
  const find = (k: string): string => { let r = k; while (parent.get(r) !== r) r = parent.get(r)!; parent.set(k, r); return r; };
  const multi = keys.filter((k) => tokens(k).length > 1);
  for (let i = 0; i < multi.length; i++) {
    for (let j = i + 1; j < multi.length; j++) {
      if (compatible(tokens(multi[i]), tokens(multi[j]))) parent.set(find(multi[i]), find(multi[j]));
    }
  }
  for (const k of keys.filter((x) => tokens(x).length === 1)) {
    const roots = new Set(multi.filter((m) => tokens(m)[0] === k).map(find));
    if (roots.size === 1) parent.set(k, [...roots][0]);
  }

  const clusters = new Map<string, string[]>();
  for (const k of keys) clusters.set(find(k), [...(clusters.get(find(k)) ?? []), k]);

  return [...clusters.values()].map((ks) => {
    const counts = new Map<string, number>();
    for (const k of ks) for (const [s, n] of spellings.get(k)!) counts.set(s, (counts.get(s) ?? 0) + n);
    // A capitalised spelling wins over a more common lowercase one ("Nitin" over "nitin").
    const ranked = [...counts.entries()].sort((a, b) =>
      capitalised(b[0]) - capitalised(a[0]) || b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]));
    const name = ranked[0][0];
    return { name, slug: personSlug(name), keys: ks.sort(), spellings: ranked.map(([x]) => x) };
  });
}

const capitalised = (s: string) => (s[0] && s[0] !== s[0].toLowerCase() ? 1 : 0);

/** Does a raw name (an item's person or a meeting participant) belong to this person? */
export function belongsTo(group: PersonGroup, raw: string | null | undefined): boolean {
  if (!raw) return false;
  const key = normalizeName(raw.includes("@") ? raw.split("@")[0].replace(/[._]+/g, " ") : raw);
  if (!key) return false;
  if (group.keys.includes(key)) return true;
  const t = tokens(key);
  // A participant written out in full ("Nitin Kumar") still matches "Nitin K".
  return group.keys.some((k) => tokens(k).length > 1 && t.length > 1 && compatible(tokens(k), t));
}

export interface PersonSummary {
  name: string;
  slug: string;
  /** Open items you owe them. */
  youOwe: number;
  /** Open items they owe you. */
  theyOwe: number;
  /** Open owe or waiting items past their due time. */
  overdue: number;
  /** Start of the latest meeting they were in, ISO, or null. */
  lastMeetingAt: string | null;
  meetingCount: number;
}

export interface PeopleInput {
  items: Item[];
  meetings: Meeting[];
  now: Date;
  /** The user's own name and aliases, never listed as a person. */
  self?: string[];
}

const live = (i: Item) => i.status !== "wrong";

/** Everyone named on an item, busiest first (open items, then most recent meeting). */
export function listPeople({ items, meetings, now, self = [] }: PeopleInput): PersonSummary[] {
  const groups = groupNames(items.filter(live).map((i) => i.person ?? "").filter(Boolean), self);
  return groups
    .map((g) => summarize(g, items, meetings, now))
    .sort((a, b) =>
      b.youOwe + b.theyOwe - (a.youOwe + a.theyOwe) ||
      (b.lastMeetingAt ?? "").localeCompare(a.lastMeetingAt ?? "") ||
      a.name.localeCompare(b.name));
}

function summarize(g: PersonGroup, items: Item[], meetings: Meeting[], now: Date): PersonSummary {
  const mine = items.filter((i) => live(i) && belongsTo(g, i.person));
  const open = mine.filter((i) => i.status === "open");
  const met = meetingsWith(g, mine, meetings);
  return {
    name: g.name,
    slug: g.slug,
    youOwe: open.filter((i) => i.kind === "owe").length,
    theyOwe: open.filter((i) => i.kind === "waiting").length,
    overdue: open.filter((i) => i.kind !== "decision" && i.dueAt && Date.parse(i.dueAt) < now.getTime()).length,
    lastMeetingAt: met[0]?.startedAt ?? null,
    meetingCount: met.length,
  };
}

/** Meetings they were in: named as a participant, or named on an item from that meeting. Newest first. */
function meetingsWith(g: PersonGroup, theirItems: Item[], meetings: Meeting[]): Meeting[] {
  const ids = new Set(theirItems.map((i) => i.meetingId));
  return meetings
    .filter((m) => ids.has(m.id) || m.participants.some((p) => belongsTo(g, p)))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** Find the person a URL segment names. Any spelling's slug works ("nitin-k" finds Nitin). */
export function findPerson(slug: string, input: PeopleInput): PersonGroup | null {
  const want = personSlug(decodeURIComponent(slug));
  if (!want) return null;
  const groups = groupNames(input.items.filter(live).map((i) => i.person ?? "").filter(Boolean), input.self ?? []);
  return groups.find((g) => g.slug === want) ?? groups.find((g) => g.keys.some((k) => personSlug(k) === want)) ?? null;
}

export interface PersonDetail {
  person: PersonGroup;
  summary: PersonSummary;
  /** Open, oldest meeting first. */
  youOwe: Item[];
  waitingOn: Item[];
  /** Closed in the last `recentDays`, newest first. */
  closed: Item[];
  /** Decisions from meetings they were in, newest first. */
  decisions: Item[];
  /** Newest first. */
  meetings: Meeting[];
}

export function personDetail(slug: string, input: PeopleInput, recentDays = 30): PersonDetail | null {
  const g = findPerson(slug, input);
  if (!g) return null;
  const { items, meetings, now } = input;
  const byId = new Map(meetings.map((m) => [m.id, m]));
  const started = (i: Item) => byId.get(i.meetingId)?.startedAt ?? i.createdAt;
  const mine = items.filter((i) => live(i) && belongsTo(g, i.person));
  const met = meetingsWith(g, mine, meetings);
  const metIds = new Set(met.map((m) => m.id));
  const since = now.getTime() - recentDays * 86400000;
  const oldest = (a: Item, b: Item) => started(a).localeCompare(started(b));
  return {
    person: g,
    summary: summarize(g, items, meetings, now),
    youOwe: mine.filter((i) => i.status === "open" && i.kind === "owe").sort(oldest),
    waitingOn: mine.filter((i) => i.status === "open" && i.kind === "waiting").sort(oldest),
    closed: mine
      .filter((i) => i.status === "done" && i.closedAt && Date.parse(i.closedAt) >= since)
      .sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? "")),
    decisions: items
      .filter((i) => i.kind === "decision" && live(i) && (metIds.has(i.meetingId) || belongsTo(g, i.person)))
      .sort((a, b) => started(b).localeCompare(started(a))),
    meetings: met,
  };
}

/** "Nitin Kumar" -> "NK", "Priya" -> "P". */
export function initials(name: string): string {
  const w = name.split(/\s+/).filter(Boolean);
  return ((w[0]?.[0] ?? "") + (w.length > 1 ? w[w.length - 1][0] : "")).toUpperCase();
}
