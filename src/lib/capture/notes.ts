// Your own notes inside a daily note (YYYY-MM-DD.md), between markers, so they survive the brief
// being written again.

export const NOTES_START = "<!-- daily-brief:your-notes -->";
export const NOTES_END = "<!-- /daily-brief:your-notes -->";
export const NOTES_HEADING = "## Your notes";

const BLOCK = /\n*<!-- daily-brief:your-notes -->\n?([\s\S]*?)\n?<!-- \/daily-brief:your-notes -->\n*/;

/** Split a note into the brief part and your notes (null when there are none). */
export function splitNotes(md: string): { brief: string; notes: string | null } {
  const m = md.match(BLOCK);
  if (!m) return { brief: md, notes: null };
  const inner = m[1].replace(/^## Your notes[ \t]*\n+/, "").replace(/\s+$/, "");
  const brief = (md.slice(0, m.index) + "\n" + md.slice(m.index! + m[0].length)).replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  return { brief, notes: inner };
}

/** The note with your notes in their block at the end (replacing an old block). Empty notes remove it. */
export function withNotes(md: string, notes: string | null): string {
  const { brief } = splitNotes(md);
  const text = (notes ?? "").replace(/\r\n/g, "\n").replace(/\s+$/, "");
  // A line that looks like our end marker would cut the block short: defuse it.
  const safe = text.replaceAll(NOTES_END, NOTES_END.replace("<!--", "<!‑-"));
  if (!safe.trim()) return brief;
  return `${brief.trimEnd()}\n\n${NOTES_START}\n${NOTES_HEADING}\n\n${safe}\n${NOTES_END}\n`;
}

/** Keep the notes from the note already on disk when the brief is written again. */
export function carryNotes(fresh: string, old: string | null): string {
  if (!old) return fresh;
  const { notes } = splitNotes(old);
  return notes === null ? fresh : withNotes(fresh, notes);
}
