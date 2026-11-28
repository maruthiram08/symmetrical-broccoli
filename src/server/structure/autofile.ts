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
import { deletePage } from "@/server/local/pages";
import { noteRows, projectRows, setNoteProperties } from "./notes";

export type FilingStore = Pick<MemoryStore, "listItems" | "listMeetingsBetween" | "fileItems">;

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

/** Where each item you haven't filed yourself would go, given these projects. Pure: writes nothing. */
function planFiling(projects: ProjectInfo[], items: Item[], meetings: Map<string, Meeting>) {
  const live = items.filter((i) => i.status !== "wrong");
  const model = buildModel(projects, allExamples(live, meetings), live.map((i) => i.text));
  return live.filter((i) => !filedByYou(i)).map((i) => ({
    item: i,
    verdict: projects.length ? judge({ id: i.id, text: i.text, title: meetings.get(i.meetingId)?.title, person: i.personRaw ?? i.person }, model) : { project: null, why: null },
  }));
}

/** File (or re-file) every item that you haven't filed yourself. */
export async function autoFileProjects(store: FilingStore, userId: string): Promise<FilingResult> {
  const projects = filingProjects();
  const [items, meetingList] = await Promise.all([store.listItems(userId), store.listMeetingsBetween(userId, "0000", "9999")]);
  const meetings = new Map(meetingList.map((m) => [m.id, m]));
  const changes: Parameters<FilingStore["fileItems"]>[0] = [];
  let filed = 0, unfiled = 0;
  // Filed by you, or taken out of a project by you (projectBy "you", no project): planFiling leaves it.
  for (const { item: i, verdict: v } of planFiling(projects, items, meetings)) {
    if (v.project) filed++; else if (i.status === "open") unfiled++;
    const want = { project: v.project, projectBy: v.project ? ("auto" as const) : null, projectWhy: v.why };
    if ((i.project ?? null) !== want.project || (i.projectBy ?? null) !== want.projectBy || (i.projectWhy ?? null) !== want.projectWhy) changes.push({ id: i.id, ...want });
  }
  const changed = changes.length ? await store.fileItems(changes) : 0;
  return { filed, unfiled, changed };
}

export interface ProjectPreview {
  /** Open items it would take, newest first (at most `max`). */
  items: Array<{ id: string; text: string; why: string | null; from: string | null }>;
  /** All items it would take, open or not. */
  total: number;
  /** Of those, how many would leave another project. */
  moved: number;
}

/**
 * What making a project named `name` would file into it, without making it: the same scorer, run
 * as if the project existed with its name as a keyword. Shown before "Make project".
 */
export async function previewProject(store: FilingStore, userId: string, name: string, max = 15): Promise<ProjectPreview> {
  const title = name.trim();
  const slug = noteSlug(title);
  const existing = filingProjects();
  const had = existing.find((p) => p.slug === slug);
  const projects = had
    ? existing.map((p) => (p.slug === slug ? { ...p, keywords: [...new Set([...p.keywords, title.toLowerCase()])] } : p))
    : [...existing, { slug, title, keywords: [title.toLowerCase()] }];
  const [items, meetingList] = await Promise.all([store.listItems(userId), store.listMeetingsBetween(userId, "0000", "9999")]);
  const meetings = new Map(meetingList.map((m) => [m.id, m]));
  const into = planFiling(projects, items, meetings).filter((x) => x.verdict.project === slug && x.item.project !== slug);
  const open = into.filter((x) => x.item.status === "open").sort((a, b) => b.item.createdAt.localeCompare(a.item.createdAt));
  return {
    items: open.slice(0, max).map((x) => ({ id: x.item.id, text: x.item.text, why: x.verdict.why, from: x.item.project ? existing.find((p) => p.slug === x.item.project)?.title ?? x.item.project : null })),
    total: into.length,
    moved: into.filter((x) => x.item.project).length,
  };
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

/**
 * You moved several items at once (into `project`, or out of any with null): each one counts as
 * a hand filing, as recordFiling does for one, and the rest are re-filed once at the end.
 * `items` are the items as they were before the move. Returns how many moved.
 */
export async function recordFilings(store: FilingStore, userId: string, items: Item[], project: string | null, at: string): Promise<number> {
  const meetings = new Map((await store.listMeetingsBetween(userId, "0000", "9999")).map((m) => [m.id, m]));
  let ex = readExamples();
  for (const item of items) {
    const not = item.projectBy === "auto" && item.project && item.project !== project ? [item.project] : [];
    ex = upsertExample(ex, { itemId: item.id, text: item.text, title: meetings.get(item.meetingId)?.title, person: item.personRaw ?? item.person, project, ...(not.length ? { not } : {}), at });
  }
  writeExamples(ex);
  const n = await store.fileItems(items.map((i) => ({ id: i.id, project, projectBy: "you" as const, projectWhy: null })));
  await autoFileProjects(store, userId);
  return n;
}

/**
 * Take a project away: every item in it goes back to "Needs a project" (or wherever the rest of
 * your projects clearly fit), and the project gets nothing new. The note is archived, or deleted
 * when `deleteNote` (an Undo right after making it). Hand filings into it are forgotten, so they
 * don't teach the scorer a project that's gone. Returns how many items it took out.
 */
export async function removeProject(store: FilingStore, userId: string, slug: string, opts: { deleteNote?: boolean } = {}): Promise<number> {
  const items = (await store.listItems(userId)).filter((i) => i.project === slug);
  if (opts.deleteNote) deletePage(slug);
  else setNoteProperties(slug, { status: "archived" });
  writeExamples(readExamples().filter((e) => e.project !== slug));
  const n = items.length ? await store.fileItems(items.map((i) => ({ id: i.id, project: null, projectBy: null, projectWhy: null }))) : 0;
  await autoFileProjects(store, userId);
  return n;
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
