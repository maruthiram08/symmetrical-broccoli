// Obsidian-style [[links]] in generated Markdown: people go to people/<Name>.md, meetings to
// meetings/<date> <title>.md, decisions to their line in decisions.md (a ^block id). Pure.

import { groupNames, normalizeName } from "@/lib/people";

/** Resolves names and ids to note names. Absent = no links (the notes as they were before links). */
export interface LinkContext {
  /** The person page for a raw name ("nitin" -> "Nitin"), or null for no page (you, or nobody). */
  person(name: string | null | undefined): string | null;
  /** The meeting note's name for a meeting id, or null. */
  meeting(meetingId: string | null | undefined): string | null;
  /** The ^block id of a decision in decisions.md. */
  decision(itemId: string): string;
}

/** A name safe as a file name and a link target on macOS, iCloud and Obsidian. */
export function noteName(s: string): string {
  return s
    .replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 100)
    .trim() || "Untitled";
}

/** Text shown inside a link: no characters that end or split a link. */
const linkText = (s: string) => s.replace(/[[\]|]/g, "").replace(/\s+/g, " ").trim();

/** [[Target]] or [[Target|shown]] */
export function wikilink(target: string, shown?: string): string {
  const t = noteName(target);
  const s = shown === undefined ? t : linkText(shown);
  return !s || s === t ? `[[${t}]]` : `[[${t}|${s}]]`;
}

/** [[decisions#^d-1234abcd|shown]]: a link to one line (block) of a note. */
export function blockLink(note: string, block: string, shown: string): string {
  return `[[${noteName(note)}#^${block.replace(/[^A-Za-z0-9-]/g, "")}|${linkText(shown)}]]`;
}

export const decisionBlockId = (itemId: string) => `d-${itemId.replace(/[^A-Za-z0-9]/g, "").slice(0, 8).toLowerCase() || "x"}`;

/** "2026-11-25 Standup" */
export const meetingNoteName = (date: string, title: string) => noteName(`${date} ${title}`);

/**
 * Build a link context from every person name the workspace knows and the meetings' note names.
 * `self` (your name and aliases) never gets a page.
 */
export function linkContext(input: { names: Iterable<string>; self?: string[]; meetings?: Map<string, string> }): LinkContext {
  const groups = groupNames(input.names, input.self ?? []);
  const byKey = new Map<string, string>();
  for (const g of groups) for (const k of g.keys) byKey.set(k, noteName(g.name));
  const skip = new Set((input.self ?? []).map(normalizeName));
  return {
    person(name) {
      const shown = name?.trim().replace(/\s+/g, " ");
      if (!shown) return null;
      const key = normalizeName(shown);
      if (!key || skip.has(key)) return null;
      return byKey.get(key) ?? noteName(shown);
    },
    meeting: (id) => (id ? input.meetings?.get(id) ?? null : null),
    decision: decisionBlockId,
  };
}

const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Link the first mention of `person` in already-escaped Markdown text. Returns the new text and
 * whether a mention was found. `escaped` is how the name appears in the text (esc(person)).
 */
export function linkMention(text: string, escaped: string, target: string, raw: string): { text: string; linked: boolean } {
  if (!escaped) return { text, linked: false };
  const re = new RegExp(`(^|[^\\p{L}\\p{N}\\[])(${reEsc(escaped)})(?![\\p{L}\\p{N}\\]])`, "iu");
  const m = re.exec(text);
  if (!m) return { text, linked: false };
  const at = m.index + m[1].length;
  const shown = text.slice(at, at + m[2].length);
  const link = wikilink(target, shown.replace(/\\(.)/g, "$1") || raw);
  return { text: text.slice(0, at) + link + text.slice(at + m[2].length), linked: true };
}
