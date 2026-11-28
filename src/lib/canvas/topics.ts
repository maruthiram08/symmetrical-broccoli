// Topics for the project map, found in the meetings themselves: a phrase from meeting titles (or
// repeated across their items) that two or more meetings share. No AI call: it reruns on every load.
import type { Item, Meeting } from "../types";
import { mentions, pairs, sentence, words } from "./text";

export interface Topic {
  /** The phrase, lowercase: "stock split". Also the map's ?topic= value. */
  key: string;
  label: string;
  meetingIds: string[];
  /** Newest meeting start, ISO. */
  last: string;
}

export const MIN_TOPIC_MEETINGS = 2;

/** The meeting's text for topic matching: its title, three times, and its items. */
function meetingText(m: Meeting, items: Item[]): { title: string; body: string } {
  return { title: m.title ?? "", body: items.map((i) => i.text).join(" \n ") };
}

/** Meetings about a phrase: it's in the title, or in two or more of the meeting's items. */
export function meetingsAbout(phrase: string, meetings: Meeting[], items: Item[]): Meeting[] {
  const byMeeting = groupItems(items);
  return meetings
    .filter((m) => !m.duplicateOf)
    .filter((m) => mentions(m.title ?? "", phrase) || (byMeeting.get(m.id) ?? []).filter((i) => mentions(i.text, phrase)).length >= 2)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export function groupItems(items: Item[]): Map<string, Item[]> {
  const out = new Map<string, Item[]>();
  for (const i of items) {
    if (i.status === "wrong") continue;
    (out.get(i.meetingId) ?? out.set(i.meetingId, []).get(i.meetingId)!).push(i);
  }
  return out;
}

/**
 * Topics across the meetings since `sinceIso`, biggest first. Two-word phrases win over single
 * words when they cover the same meetings; a topic whose meetings are mostly another's is dropped.
 */
export function findTopics(meetings: Meeting[], items: Item[], sinceIso: string, max = 12): Topic[] {
  const recent = meetings.filter((m) => !m.duplicateOf && m.startedAt >= sinceIso);
  const byMeeting = groupItems(items);
  const cands = new Map<string, Set<string>>();
  const add = (k: string, id: string) => (cands.get(k) ?? cands.set(k, new Set()).get(k)!).add(id);
  for (const m of recent) {
    const { title, body } = meetingText(m, byMeeting.get(m.id) ?? []);
    for (const p of new Set(pairs(title))) add(p, m.id);
    for (const w of new Set(words(title))) add(w, m.id);
    // A phrase repeated across the meeting's items counts too ("dividend" in three items).
    const counts = new Map<string, number>();
    for (const p of pairs(body)) counts.set(p, (counts.get(p) ?? 0) + 1);
    for (const [p, n] of counts) if (n >= 2) add(p, m.id);
  }
  const scored = [...cands]
    .filter(([, ids]) => ids.size >= MIN_TOPIC_MEETINGS)
    // A two-word phrase beats its single words unless they cover clearly more meetings.
    .map(([key, ids]) => ({ key, ids, score: ids.size * (key.includes(" ") ? 1.5 : 1) }))
    .sort((a, b) => b.score - a.score || b.key.length - a.key.length);
  const picked: Array<{ key: string; ids: Set<string> }> = [];
  for (const c of scored) {
    const dup = picked.some((p) => {
      const inter = [...c.ids].filter((id) => p.ids.has(id)).length;
      return inter / c.ids.size >= 0.7 || (p.key.includes(" ") && p.key.split(" ").includes(c.key));
    });
    if (!dup) picked.push(c);
    if (picked.length >= max) break;
  }
  const start = new Map(recent.map((m) => [m.id, m.startedAt]));
  return picked.map((p) => ({
    key: p.key,
    label: sentence(p.key),
    meetingIds: [...p.ids].sort((a, b) => (start.get(a) ?? "").localeCompare(start.get(b) ?? "")),
    last: [...p.ids].map((id) => start.get(id) ?? "").sort().pop() ?? "",
  }));
}
