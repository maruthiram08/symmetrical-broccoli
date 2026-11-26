// What a brief writes beyond the daily note: rendering through your templates with [[links]],
// person pages and meeting notes, then folder sync and git. Nothing here can stop a brief:
// every step after the daily note is written catches its own errors and records them for Settings.

import { join } from "node:path";
import { localDate } from "@/lib/brief/time";
import type { WeekModel } from "@/lib/brief/week";
import { carryNotes } from "@/lib/capture/notes";
import { belongsTo, groupNames } from "@/lib/people";
import { renderDaily, renderDecisionsLines } from "@/lib/templates/daily";
import { TemplateError } from "@/lib/templates/engine";
import type { TemplateKind } from "@/lib/templates/kinds";
import { linkContext, meetingNoteName, noteName, type LinkContext } from "@/lib/templates/links";
import { meetingNoteFile, renderMeetingNote, renderPersonPage } from "@/lib/templates/meeting";
import { renderWeek } from "@/lib/templates/week";
import type { BriefModel, Item, Meeting, User } from "@/lib/types";
import type { Store } from "@/server/store";
import { existsSync, readFileSync } from "node:fs";
import { writeAtomic } from "./atomic";
import { syncFolder } from "./folder-sync";
import { commitFiles, isGitRepo, pushTo } from "./git-sync";
import { recordSync } from "./sync-status";
import { loadTemplate } from "./templates";
import { gitSettings, linksOn, type Workspace } from "./workspaces";

interface Loaded { user: User; items: Item[]; meetings: Meeting[]; links: LinkContext; names: string[]; self: string[] }

async function load(store: Store, user: User): Promise<Loaded> {
  const items = (await store.listItems(user.id)).filter((i) => i.status !== "wrong");
  const meetings = await store.listMeetingsBetween(user.id, "0000", "9999");
  const names = [
    ...items.map((i) => i.person).filter((p): p is string => !!p?.trim()),
    ...meetings.flatMap((m) => m.participants).filter((p) => !p.includes("@")),
  ];
  const self = [user.name, ...user.aliases].filter(Boolean);
  // Two meetings with the same title on the same day get "… (2)", oldest first.
  const notes = new Map<string, string>();
  const taken = new Set<string>();
  for (const m of [...meetings].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id))) {
    const base = meetingNoteName(localDate(new Date(m.startedAt), user.timeZone), m.title);
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} (${n})`;
    taken.add(name.toLowerCase());
    notes.set(m.id, name);
  }
  return { user, items, meetings, names, self, links: linkContext({ names, self, meetings: notes }) };
}

async function linksFor(ws: Workspace, store: Store, userId: string): Promise<Loaded | null> {
  if (!linksOn(ws)) return null;
  const user = await store.getUser(userId);
  return user ? load(store, user) : null;
}

/** Render with your template; a broken one falls back to the default and says so in Settings. */
function withTemplate<T>(ws: Workspace, kind: TemplateKind, render: (template: string | null) => T): T {
  const template = loadTemplate(ws, kind);
  if (template === null) return render(null);
  try {
    const out = render(template);
    recordSync(ws, { template: undefined });
    return out;
  } catch (e) {
    if (!(e instanceof TemplateError)) throw e;
    recordSync(ws, { template: { at: new Date().toISOString(), ok: false, detail: `Your ${kind} template: ${e.message} The default was used.` } });
    return render(null);
  }
}

export async function renderDailyFor(ws: Workspace, store: Store, model: BriefModel): Promise<string> {
  const l = await linksFor(ws, store, model.userId);
  return withTemplate(ws, "daily", (template) => renderDaily(model, { template, links: l?.links }));
}

export async function renderWeekFor(ws: Workspace, store: Store, user: User, week: WeekModel): Promise<string> {
  const l = await linksFor(ws, store, user.id);
  return withTemplate(ws, "week", (template) => renderWeek(week, { template, links: l?.links }));
}

export async function renderDecisionsFor(ws: Workspace, store: Store, model: BriefModel): Promise<string> {
  const l = await linksFor(ws, store, model.userId);
  return renderDecisionsLines(model, l?.links);
}

/** Write a generated page, keeping your notes section (as on daily notes). Returns true when it changed. */
function writePage(dir: string, rel: string, md: string): boolean {
  const p = join(dir, rel);
  return writeAtomic(p, carryNotes(md, existsSync(p) ? readFileSync(p, "utf8") : null));
}

/**
 * people/<Name>.md for everyone with items, and meetings/<date> <title>.md for every meeting, so
 * each [[link]] in the notes has a page. Unchanged pages aren't written again. Returns the
 * relative paths of all the pages.
 */
export function writeLinkedPages(ws: Workspace, data: Loaded, now: Date): string[] {
  const { user, items, meetings, links } = data;
  const tz = user.timeZone;
  const out: string[] = [];
  const byId = new Map(meetings.map((m) => [m.id, m]));
  for (const m of meetings) {
    const id = m.id;
    const input = { meeting: m, items: items.filter((i) => i.meetingId === id), closed: items.filter((i) => i.closedByMeetingId === id && i.meetingId !== id), timeZone: tz, now };
    const md = withTemplate(ws, "meeting", (t) => renderMeetingNote(input, { template: t, links }));
    const rel = `meetings/${links.meeting(id) ?? meetingNoteFile(m, tz).replace(/\.md$/, "")}.md`;
    writePage(ws.path, rel, md);
    out.push(rel);
  }

  const groups = groupNames(data.names, data.self);
  const seen = new Set<string>();
  for (const g of groups) {
    const mine = items.filter((i) => i.kind !== "decision" && belongsTo(g, i.person));
    if (!mine.length) continue;
    const file = noteName(g.name);
    if (seen.has(file.toLowerCase())) continue; // two people whose names clean up the same: first one wins
    seen.add(file.toLowerCase());
    const rel = `people/${file}.md`;
    writePage(ws.path, rel, renderPersonPage({ name: g.name, items: mine, meetings: byId, timeZone: tz, now, links }));
    out.push(rel);
  }
  return out;
}

const result = (ok: boolean, detail: string) => ({ at: new Date().toISOString(), ok, detail });

/** Mirror into the sync folder when one is set. Never throws. */
export function runFolderSync(ws: Workspace): void {
  if (!ws.sync?.enabled || !ws.sync.folder) return;
  try {
    const r = syncFolder(ws, ws.sync.folder);
    recordSync(ws, { folder: result(true, `${r.copied} updated, ${r.unchanged} unchanged${r.removed ? `, ${r.removed} removed` : ""}`) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Couldn't sync the folder.";
    console.error(`[sync] folder: ${msg}`);
    recordSync(ws, { folder: result(false, msg.slice(0, 200)) });
  }
}

/** Commit (and push, when on) when the notes folder is a git repo. Never throws. */
export async function runGitSync(ws: Workspace, files: string[], date: string): Promise<void> {
  const g = gitSettings(ws);
  if (!g.commit) return;
  try {
    if (!(await isGitRepo(ws.path))) return;
    const c = await commitFiles(ws.path, files, `Daily brief ${date}`);
    if (c.status === "failed") {
      console.error(`[sync] git commit: ${c.reason}`);
      recordSync(ws, { git: result(false, c.reason) });
      return;
    }
    recordSync(ws, { git: result(true, c.status === "committed" ? `Committed ${c.commit}` : "Nothing new to commit") });
    if (!g.push) return;
    const p = await pushTo(ws.path, g.remote);
    if (p.status === "failed") console.error(`[sync] git push: ${p.reason}`);
    recordSync(ws, { push: result(p.status === "pushed", p.status === "pushed" ? `Pushed to ${g.remote}` : p.reason) });
  } catch (e) {
    recordSync(ws, { git: result(false, e instanceof Error ? e.name : "Error") });
  }
}

/** After the daily note is written: linked pages, folder sync, git. Never throws. */
export async function afterPublish(ws: Workspace, store: Store, user: User, model: BriefModel, week?: { key: string }, now = new Date()): Promise<string[]> {
  const files = [`${model.date}.md`, "decisions.md", ...(week ? [`week-${week.key}.md`] : [])];
  try {
    if (linksOn(ws)) files.push(...writeLinkedPages(ws, await load(store, user), now));
  } catch (e) {
    console.error(`[sync] linked pages: ${e instanceof Error ? e.name : "Error"}`);
  }
  runFolderSync(ws);
  await runGitSync(ws, files, model.date);
  return files;
}

/** Settings' "Sync now": rebuild the linked pages from the stored data and mirror the folder. */
export async function syncNow(ws: Workspace, store: Store, user: User, now = new Date()): Promise<void> {
  if (linksOn(ws)) {
    try {
      writeLinkedPages(ws, await load(store, user), now);
    } catch (e) {
      console.error(`[sync] linked pages: ${e instanceof Error ? e.name : "Error"}`);
    }
  }
  runFolderSync(ws);
}
