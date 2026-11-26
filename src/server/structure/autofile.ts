// Automatic project filing on the local app (the scorer is src/lib/projects/autofile.ts).
// Runs after each meeting is read, after you correct a filing, and when you make a project. It
// re-checks every item it filed itself and every unfiled one; what you filed by hand is never moved.
// Your corrections are kept in <data>/project-filing.json, so a re-read of all meetings keeps them.
import { join } from "node:path";
import { findTopics } from "@/lib/canvas/topics";
import { mentions, sentence, words } from "@/lib/canvas/text";
import { buildModel, isClosedProject, judge, keywordList, upsertExample, type FilingExample, type ProjectInfo } from "@/lib/projects/autofile";
import type { Item, Meeting } from "@/lib/types";
import type { MemoryStore } from "@/server/store";
import { dataDir } from "@/server/local/paths";
import { readJson, writeJson } from "@/server/local/json-file";
import { noteSlug } from "@/lib/editor/links";
import { noteRows, projectRows } from "./notes";

type FilingStore = Pick<MemoryStore, "listItems" | "listMeetingsBetween" | "fileItems">;

interface FilingFile { version: 1; examples: FilingExample[] }
const filePath = () => join(dataDir(), "project-filing.json");
export const readExamples = (): FilingExample[] => readJson<FilingFile>(filePath(), { version: 1, examples: [] }).examples;
const writeExamples = (examples: FilingExample[]) => writeJson(filePath(), { version: 1, examples } satisfies FilingFile);

/** Projects that can take new items: Project notes not marked done or archived. */
export function filingProjects(): ProjectInfo[] {
  return projectRows(noteRows())
    .filter((p) => !isClosedProject(p.props.status))
    .map((p) => ({ slug: p.slug, title: p.title, keywords: keywordList(p.props.keywords ?? p.props.keyword ?? p.props.aliases) }));
}

/** Filed by you: marked so, or filed before automatic filing existed. */
export const filedByYou = (i: Pick<Item, "project" | "projectBy">) => i.projectBy === "you" || (!!i.project && !i.projectBy);

/** Your hand filings as examples: the file, plus items you filed before it existed. */
function allExamples(items: Item[], meetings: Map<string, Meeting>): FilingExample[] {
  let ex = readExamples();
  const known = new Set(ex.map((e) => e.itemId));
  for (const i of items) {
    if (i.status === "wrong" || known.has(i.id) || !i.project || i.projectBy) continue;
    ex = upsertExample(ex, { itemId: i.id, text: i.text, title: meetings.get(i.meetingId)?.title, person: i.person, project: i.project, at: i.createdAt });
  }
  return ex;
}

export interface FilingResult { filed: number; unfiled: number; changed: number }

/** File (or re-file) every item that you haven't filed yourself. */
export async function autoFileProjects(store: FilingStore, userId: string): Promise<FilingResult> {
  const projects = filingProjects();
  const [items, meetingList] = await Promise.all([store.listItems(userId), store.listMeetingsBetween(userId, "0000", "9999")]);
  const meetings = new Map(meetingList.map((m) => [m.id, m]));
  const live = items.filter((i) => i.status !== "wrong");
  const model = buildModel(projects, allExamples(live, meetings), live.map((i) => i.text));
  const changes: Parameters<FilingStore["fileItems"]>[0] = [];
  let filed = 0, unfiled = 0;
  for (const i of live) {
    // Filed by you, or taken out of a project by you (projectBy "you", no project): leave it.
    if (filedByYou(i)) continue;
    const v = projects.length ? judge({ id: i.id, text: i.text, title: meetings.get(i.meetingId)?.title, person: i.personRaw ?? i.person }, model) : { project: null, why: null };
    if (v.project) filed++; else if (i.status === "open") unfiled++;
    const want = { project: v.project, projectBy: v.project ? ("auto" as const) : null, projectWhy: v.why };
    if ((i.project ?? null) !== want.project || (i.projectBy ?? null) !== want.projectBy || (i.projectWhy ?? null) !== want.projectWhy) changes.push({ id: i.id, ...want });
  }
  const changed = changes.length ? await store.fileItems(changes) : 0;
  return { filed, unfiled, changed };
}

/**
 * You filed (or unfiled) an item by hand: remember it as an example, and as a "not this one"
 * when it was an automatic filing you changed. Then re-file the rest with what that taught.
 * `item` is the item as it was before your change.
 */
export async function recordFiling(store: FilingStore, userId: string, item: Item, project: string | null, at: string): Promise<void> {
  const meeting = (await store.listMeetingsBetween(userId, "0000", "9999")).find((m) => m.id === item.meetingId);
  const not = item.projectBy === "auto" && item.project && item.project !== project ? [item.project] : [];
  writeExamples(upsertExample(readExamples(), { itemId: item.id, text: item.text, title: meeting?.title, person: item.personRaw ?? item.person, project, ...(not.length ? { not } : {}), at }));
  await autoFileProjects(store, userId);
}

export interface SuggestedProject { key: string; label: string; meetings: number; items: number }

/**
 * Projects worth making, from the topics your meetings share (the canvas Project map): ones no
 * project already covers. Making one seeds it with the topic as a keyword.
 */
export function suggestProjects(items: Item[], meetings: Meeting[], projects: ProjectInfo[], sinceIso: string, max = 6): SuggestedProject[] {
  const covered = new Set(projects.flatMap((p) => [p.title, ...p.keywords]).map((k) => noteSlug(words(k).join(" "))));
  const open = items.filter((i) => i.status !== "wrong");
  const byId = new Map(meetings.map((m) => [m.id, m]));
  return findTopics(meetings, open, sinceIso, 20)
    .filter((t) => {
      const k = noteSlug(t.key);
      return !covered.has(k) && ![...covered].some((c) => c.includes(k) || k.includes(c));
    })
    .map((t) => {
      const mine = open.filter((i) => t.meetingIds.includes(i.meetingId));
      return { key: t.key, label: naturalLabel(t.key, t.meetingIds.map((id) => byId.get(id)?.title ?? "")), meetings: t.meetingIds.length, items: mine.length, talked: mine.filter((i) => mentions(i.text, t.key)).length };
    })
    // A word only in titles ("Untitled", the company's name) isn't a project: its items must say it too.
    .filter((t) => t.items > 0 && t.talked >= 2)
    .slice(0, max)
    .map((t) => ({ key: t.key, label: t.label, meetings: t.meetings, items: t.items }));
}

/** The topic as your meeting titles spell it: "earning tag" → "Earnings tag". */
export function naturalLabel(key: string, titles: string[]): string {
  const want = key.split(" ");
  for (const title of titles) {
    const raw = title.match(/[\p{L}\p{N}]+/gu) ?? [];
    for (let i = 0; i + want.length <= raw.length; i++) {
      const slice = raw.slice(i, i + want.length);
      if (words(slice.join(" ")).join(" ") === key) return sentence(slice.join(" ").toLowerCase());
    }
  }
  return sentence(key);
}
