// Generic labels transcription gives a voice it couldn't name: "Speaker 5", "Speaker A", "Unknown",
// "Participant 2", "Guest". They are nobody in particular, so they never become people or review
// cards; their items show as unattributed. Stored names are never rewritten. Pure.

/** What items show in place of a speaker label. */
export const UNLABELLED = "someone (unlabelled speaker)";

const WORDS = "speaker|spkr|spk|participant|guest|unknown|unidentified|attendee|caller|voice|person|other|someone|anonymous|interviewee|interviewer";
const LABEL = new RegExp(
  `^(?:(?:unknown|unidentified|other|anonymous)\\s+)?(?:${WORDS})(?:\\s*(?:#|no\\.?)?\\s*(?:\\d{1,3}|[a-z]))?$`,
  "i",
);
// "S1", "SPK_2": a bare letter and number
const SHORT = /^(?:s|spk|p)\s*\d{1,3}$/i;

const clean = (s: string) => s.normalize("NFKC").replace(/[_\-:()[\]]+/g, " ").replace(/\s+/g, " ").trim();

/** True for "Speaker 5", "speaker_a", "Unknown Speaker", "Participant 2", "Guest", "S1". */
export function isSpeakerLabel(name: string | null | undefined): boolean {
  if (!name) return false;
  const s = clean(name);
  return !!s && (LABEL.test(s) || SHORT.test(s));
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Item text with the label replaced: "Send Speaker 5 the deck" -> "Send someone (unlabelled speaker) the deck". */
export function unlabelText(text: string, label: string): string {
  const words = clean(label).split(" ").map(esc).join("[\\s_-]*");
  return text.replace(new RegExp(`(?<![\\p{L}\\p{N}])${words}(?![\\p{L}\\p{N}])`, "giu"), UNLABELLED);
}
