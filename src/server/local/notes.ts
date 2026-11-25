import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { splitNotes, withNotes } from "@/lib/capture/notes";
import { getStore } from "./app";
import { notesDir } from "./paths";

export const notePath = (date: string, dir = notesDir()) => join(dir, `${date}.md`);

/**
 * A day's note: the file in your notes folder when it's there (it is the source of truth, and you
 * may have edited it), else the copy kept in state.json. Your notes come back separately.
 */
export async function readDayNote(userId: string, date: string, dir = notesDir()): Promise<{ brief: string; notes: string; fromFile: boolean } | null> {
  const path = notePath(date, dir);
  if (existsSync(path)) {
    const { brief, notes } = splitNotes(readFileSync(path, "utf8"));
    return { brief, notes: notes ?? "", fromFile: true };
  }
  const stored = (await getStore().listBriefs(userId)).find((b) => b.date === date);
  if (!stored) return null;
  return { brief: splitNotes(stored.markdown).brief, notes: "", fromFile: false };
}

/** Write your notes into the day's .md between the markers, leaving the rest of the file as it is. */
export async function saveDayNotes(userId: string, date: string, notes: string, dir = notesDir()): Promise<void> {
  const path = notePath(date, dir);
  let md: string;
  if (existsSync(path)) md = readFileSync(path, "utf8");
  else {
    const stored = (await getStore().listBriefs(userId)).find((b) => b.date === date);
    md = stored?.markdown ?? `# ${date}\n`;
  }
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, withNotes(md, notes));
  renameSync(tmp, path);
}
