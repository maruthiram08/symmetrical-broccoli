// Shared pieces of the transcript parsers: speaker turns, dates found in names and text, titles.
// Everything here is pure (no file access) so the fixture tests cover it fully.
import { zonedTime } from "@/lib/brief/time";

/** One stretch of speech. `speaker` is null when the file has no speaker labels. */
export interface Turn {
  speaker: string | null;
  text: string;
  /** Seconds from the start of the recording, when the format has it. */
  at?: number | null;
}

/** What a parser could read from one transcript file. Any field may be missing. */
export interface ParsedTranscript {
  /** Plain "Speaker: text" lines, the form the extraction reads. */
  text: string;
  speakers: string[];
  /** Title found in the contents (a heading or a Google Meet title line), if any. */
  title: string | null;
  /** Start time found in the contents (ISO UTC), if any. */
  startedAt: string | null;
  /** Seconds from the first to the last cue, when the format has timings. */
  durationSec: number | null;
  /** Hints for the inbox about what kind of transcript this is. */
  looksLikeMeet: boolean;
  looksLikePhone: boolean;
}

/** Merge consecutive turns of one speaker and render "Speaker: text" lines. */
export function renderTurns(turns: Turn[]): string {
  const merged: Turn[] = [];
  for (const t of turns) {
    const text = t.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const last = merged[merged.length - 1];
    if (last && last.speaker === t.speaker) last.text += " " + text;
    else merged.push({ speaker: t.speaker, text });
  }
  return merged.map((t) => (t.speaker ? `${t.speaker}: ${t.text}` : t.text)).join("\n");
}

export function speakersOf(turns: Turn[]): string[] {
  const seen = new Map<string, string>();
  for (const t of turns) if (t.speaker && !seen.has(t.speaker.toLowerCase())) seen.set(t.speaker.toLowerCase(), t.speaker);
  return [...seen.values()];
}

/** "01:02:03.500", "02:03,5", "1:02:03" -> seconds. Null when it isn't a timestamp. */
export function parseClock(s: string): number | null {
  const m = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/.exec(s.trim());
  if (!m) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + (m[4] ? Number(`0.${m[4]}`) : 0);
}

/** A name before a colon that looks like a speaker label ("Asha Rao", "Speaker 1", "Me"), not a sentence. */
export function speakerLabel(s: string): string | null {
  const name = s.trim();
  if (!name || name.length > 40) return null;
  if (/^(https?|note|notes|action items?|summary|date|time|title|attendees|participants|agenda|transcript|subject|re|fwd)$/i.test(name)) return null;
  if (/[.?!,;]|\d{1,2}:\d{2}/.test(name)) return null;
  const words = name.split(/\s+/);
  if (words.length > 4) return null;
  // Names are capitalized words (or "Speaker 2"); a lowercase first word reads like a sentence.
  if (!/^[\p{Lu}\p{Lo}]/u.test(words[0])) return null;
  return name;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MON = "(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?";
const TIME = "(\\d{1,2})[:.\\-](\\d{2})(?:[:.\\-](\\d{2}))?\\s*([ap]\\.?m\\.?)?";
const ZONE = "(?:\\s*\\(?\\s*(?:(?:GMT|UTC)\\s*([+-])(\\d{1,2})(?::?(\\d{2}))?|(Z|GMT|UTC)\\b))?";

const pad = (n: number) => String(n).padStart(2, "0");

function build(y: number, mo: number, d: number, time: RegExpExecArray | string[] | null, i: number, timeZone: string): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null;
  let h = 0, mi = 0, s = 0;
  const hasTime = !!time && time[i] !== undefined;
  if (hasTime && time) {
    h = Number(time[i]); mi = Number(time[i + 1]); s = Number(time[i + 2] ?? 0);
    const ampm = time[i + 3]?.toLowerCase().replace(/\./g, "");
    if (ampm === "pm" && h < 12) h += 12;
    if (ampm === "am" && h === 12) h = 0;
    if (h > 23 || mi > 59 || s > 59) return null;
  }
  const date = `${y}-${pad(mo)}-${pad(d)}`;
  if (time && (time[i + 4] || time[i + 7])) {
    // An explicit offset ("GMT+05:30") or UTC marker wins over the user's zone.
    const sign = time[i + 4] === "-" ? -1 : 1;
    const off = time[i + 4] ? sign * (Number(time[i + 5]) * 60 + Number(time[i + 6] ?? 0)) : 0;
    return new Date(Date.UTC(y, mo - 1, d, h, mi, s) - off * 60_000).toISOString();
  }
  const t = zonedTime(date, `${pad(h)}:${pad(mi)}`, timeZone);
  return new Date(t.getTime() + s * 1000).toISOString();
}

/**
 * The first date (and time, when given) in a file name or a few lines of text, as ISO UTC.
 * Wall-clock times without a zone are read in `timeZone` (the user's). Understands:
 *  - Zoom cloud names "GMT20261124-043000" (UTC)
 *  - "2026-11-24 10.00.00", "2026-11-24T10:00", "2026/11/24 10:00 GMT+05:30"
 *  - "24 Nov 2026 10:00 AM", "Nov 24, 2026 at 10:00 AM"
 * A date with no time counts as 09:00 local, so the meeting lands on the right day.
 */
export function findDate(s: string, timeZone: string): { iso: string; hasTime: boolean } | null {
  const zoom = /GMT(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(s);
  if (zoom) {
    const [, y, mo, d, h, mi, se] = zoom.map(Number);
    return { iso: new Date(Date.UTC(y, mo - 1, d, h, mi, se)).toISOString(), hasTime: true };
  }
  const iso = new RegExp(`(\\d{4})[-/.](\\d{2})[-/.](\\d{2})(?:(?:[ T_]+|,\\s*|\\s+at\\s+)${TIME}${ZONE})?`, "i").exec(s);
  const dmy = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MON},?\\s+(\\d{4})(?:(?:,?\\s+(?:at\\s+)?)${TIME}${ZONE})?`, "i").exec(s);
  const mdy = new RegExp(`\\b${MON}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})(?:(?:,?\\s+(?:at\\s+)?)${TIME}${ZONE})?`, "i").exec(s);
  const found = [iso, dmy, mdy].filter((m): m is RegExpExecArray => !!m).sort((a, b) => a.index - b.index)[0];
  if (!found) return null;
  let out: string | null = null;
  if (found === iso) out = build(Number(iso[1]), Number(iso[2]), Number(iso[3]), iso, 4, timeZone);
  else if (found === dmy) out = build(Number(dmy[3]), MONTHS.indexOf(dmy[2].slice(0, 3).toLowerCase()) + 1, Number(dmy[1]), dmy, 4, timeZone);
  else if (mdy) out = build(Number(mdy[3]), MONTHS.indexOf(mdy[1].slice(0, 3).toLowerCase()) + 1, Number(mdy[2]), mdy, 4, timeZone);
  if (!out) return null;
  const hasTime = found[4] !== undefined;
  if (!hasTime) {
    const day = found === iso ? `${found[1]}-${found[2]}-${found[3]}` : out.slice(0, 10);
    return { iso: zonedTime(day, "09:00", timeZone).toISOString(), hasTime: false };
  }
  return { iso: out, hasTime };
}

/** A readable title from a file name: no extension, dates, Zoom ids or "Transcript" suffixes. */
export function titleFromName(name: string): string {
  let t = name.replace(/\.[a-z0-9]{1,5}$/i, "");
  t = t.replace(/GMT\d{8}-\d{6}(_Recording)?/gi, " ");
  t = t.replace(/\(?\d{4}[-/.]\d{2}[-/.]\d{2}(?:[ T_]+\d{1,2}[:.\-]\d{2}(?:[:.\-]\d{2})?(?:\s*[ap]m)?)?(?:\s*(?:GMT|UTC)\s*[+-]?\d{0,2}(?::?\d{2})?)?\)?/gi, " ");
  t = t.replace(/\b(meeting_saved_closed_caption|closed_caption|audio_transcript|transcript|recording|captions?)\b/gi, " ");
  t = t.replace(/[_]+/g, " ").replace(/\s*[-–—|]\s*$/g, "").replace(/^\s*[-–—|]\s*/g, "");
  t = t.replace(/\s*[-–—]\s*(?=[-–—])/g, "").replace(/\s+/g, " ").trim();
  t = t.replace(/^[-–—.,\s]+|[-–—.,\s]+$/g, "");
  return /[\p{L}\p{N}]/u.test(t) ? t : "";
}

/** Clean a title found in the contents: no markdown, "- Transcript" suffix or trailing "(date)". */
export function cleanTitle(line: string): string {
  return line
    .replace(/^#+\s*/, "")
    .replace(/\s*\((?=[^)]*\d{4})[^)]*\)\s*/g, " ")
    .replace(/\s*[-–—]\s*(transcript|meeting transcript|notes by gemini)\s*$/i, "")
    .replace(/^transcript\s*[:\-–—]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Call transcripts: words that mark a file as a phone call rather than a meeting. */
export const PHONE_RE = /\b(phone call|call recording|call with|call from|call to|just press record|incoming call|outgoing call|voicemail)\b/i;
/** Google Meet transcript markers. */
export const MEET_RE = /\b(google meet|meet\.google\.com|notes by gemini|meeting records|transcript ended after)\b/i;
