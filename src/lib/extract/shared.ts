// Rules for meetings someone else recorded and shared with the user (Wispr Flow shared=true).
// The model reads them like any other meeting; these checks then decide what may reach the brief,
// so a colleague's notes never put promises on the user's list that the user didn't make.
import type { ExtractionResult, User } from "../types";

type Names = Pick<User, "name" | "aliases">;

function namesOf(u: Names): string[] {
  return [u.name, ...u.aliases].map((n) => n.trim().toLowerCase()).filter((n) => n.length >= 2);
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** True when `text` contains one of the names as a whole word (case-insensitive, any script). */
function hasName(text: string, names: string[]): boolean {
  const t = text.toLowerCase();
  return names.some((n) => new RegExp(`(^|[^\\p{L}\\p{N}])${escape(n)}($|[^\\p{L}\\p{N}])`, "u").test(t));
}

/**
 * Speaker labels in a transcript: the "Name:" at the start of each line, after an optional
 * "[00:01:02]" or "00:01" timestamp. Wispr Flow writes "Maruthi: text" (observed 2026-11-25).
 */
export function speakerLabels(transcript: string): string[] {
  const out = new Set<string>();
  for (const line of transcript.split("\n")) {
    const m = line.match(/^\s*(?:\[?\d{1,2}:\d{2}(?::\d{2})?\]?\s*[-–]?\s*)?([^:\n]{1,60}?)\s*:\s/);
    if (m && !/^\d+$/.test(m[1].trim())) out.add(m[1].trim());
  }
  return [...out];
}

/** The user (by name or an alias) is one of the transcript's speakers. */
export function userSpeaks(transcript: string, user: Names): boolean {
  const names = namesOf(user);
  return names.length > 0 && speakerLabels(transcript).some((label) => hasName(label, names));
}

/** The user's name or an alias appears anywhere in `text`. */
export function namesUser(text: string, user: Names): boolean {
  const names = namesOf(user);
  return names.length > 0 && hasName(text, names);
}

/**
 * Is a shared meeting worth an AI read? Only when the user speaks in it or is named in it:
 * otherwise nothing from it could reach the brief (see keepSharedItems).
 */
export function sharedMeetingConcernsUser(transcript: string, user: Names): boolean {
  return userSpeaks(transcript, user) || namesUser(transcript, user);
}

/**
 * Items from a shared meeting. When the user speaks in it, everything stands, as in their own
 * meetings. When they don't, nothing counts as "You owe", and Waiting on and decisions stay only
 * when the item's quote or text names the user.
 */
export function keepSharedItems(
  items: ExtractionResult["newItems"],
  transcript: string,
  user: Names,
): ExtractionResult["newItems"] {
  if (userSpeaks(transcript, user)) return items;
  return items.filter((i) => i.kind !== "owe" && (namesUser(i.quote, user) || namesUser(i.text, user)));
}
