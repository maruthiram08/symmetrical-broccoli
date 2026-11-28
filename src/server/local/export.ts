// What a page exports: a note, an earlier day (its brief and your notes), or today's brief.
import { buildBrief } from "@/lib/brief/build";
import { renderMarkdown } from "@/lib/brief/markdown";
import { dateLabel, localDate } from "@/lib/brief/time";
import type { ExportDoc } from "@/lib/export/doc";
import type { User } from "@/lib/types";
import { getStore } from "./app";
import { readDayNote } from "./notes";
import { readPage } from "./pages";

export type ExportType = "note" | "day";

const withNotes = (brief: string, notes: string) => (notes.trim() ? `${brief.trimEnd()}\n\n## Your notes\n\n${notes.trim()}\n` : brief);

/** `id` is a note's slug, a YYYY-MM-DD date, or "today". Null when there is no such page. */
export async function exportDoc(user: User, type: string, id: string, now = new Date()): Promise<ExportDoc | null> {
  if (type === "note") {
    const p = readPage(id);
    return p ? { title: p.title, subtitle: null, markdown: p.markdown } : null;
  }
  if (type !== "day") return null;
  const today = localDate(now, user.timeZone);
  if (id === "today" || id === today) {
    const b = await buildBrief(getStore(), user, now);
    const note = await readDayNote(user.id, b.date).catch(() => null);
    return { title: b.dateLabel, subtitle: "Today's brief", markdown: withNotes(renderMarkdown(b), note?.notes ?? "") };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(id)) return null;
  const note = await readDayNote(user.id, id);
  if (!note) return null;
  return { title: dateLabel(id), subtitle: "Daily brief", markdown: withNotes(note.brief, note.notes) };
}
