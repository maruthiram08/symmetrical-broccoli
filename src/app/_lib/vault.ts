import { existsSync } from "node:fs";
import { dateLabel, localDate } from "@/lib/brief/time";
import { parseDayQuery } from "@/lib/dates/natural";
import type { User } from "@/lib/types";
import { noteHref } from "@/lib/vault/layout";
import { getStore } from "@/server/local/app";
import { notePath } from "@/server/local/notes";
import { listPages } from "@/server/local/pages";
import { notesDir } from "@/server/local/paths";
import { currentWorkspace } from "@/server/local/workspaces";
import { folderPaths, noteName, walkVault } from "@/server/local/vault";
import { searchVault } from "@/server/local/vault-index";
import { assistStatusFor } from "./editor";

export interface PaletteNote { path: string; title: string; snippet: string; href: string }
export interface PaletteDay { date: string; label: string; exists: boolean; href: string }

/** For ⌘K: matching notes from the full-text index, and the day a query like "last tuesday" names. */
export async function noteSearch(user: User, q: string, now = new Date()): Promise<{ notes: PaletteNote[]; day: PaletteDay | null }> {
  let notes: PaletteNote[] = [];
  let day: PaletteDay | null = null;
  try {
    if (q.trim()) notes = searchVault(notesDir(), q, 6).map((h) => ({ path: h.path, title: h.title, snippet: h.snippet, href: noteHref(h.path) }));
  } catch { notes = []; }
  try {
    const date = q.trim() ? parseDayQuery(q, localDate(now, user.timeZone)) : null;
    if (date) {
      const exists = existsSync(notePath(date)) || (await getStore().listBriefs(user.id)).some((b) => b.date === date);
      day = { date, label: dateLabel(date), exists, href: `/day/${date}` };
    }
  } catch { day = null; }
  return { notes, day };
}

/** What the notes workbench needs from the server. */
export async function vaultContext(user: User, now = new Date()) {
  const root = notesDir();
  const { tree, files, truncated } = walkVault(root);
  // [[Untyped]] links resolve to notes in notes/ first, then to any note by its file name.
  const notes = [
    ...listPages().map((p) => ({ slug: p.slug, title: p.title })),
    ...files.filter((f) => !/^notes\/[^/]+\.md$/.test(f.path)).map((f) => ({ slug: f.path.replace(/\.md$/i, ""), title: noteName(f.path) })),
  ];
  return {
    workspaceId: currentWorkspace().id,
    rootLabel: root.replace(/^\/Users\/[^/]+/, "~"),
    tree,
    folders: folderPaths(tree),
    truncated,
    timeZone: user.timeZone,
    today: localDate(now, user.timeZone),
    assist: await assistStatusFor(),
    notes,
  };
}
export type VaultContext = Awaited<ReturnType<typeof vaultContext>>;
