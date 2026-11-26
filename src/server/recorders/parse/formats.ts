// Parsers for the transcript formats people actually have: WebVTT, SubRip, Zoom's saved closed
// captions, and plain text / Markdown (Google Meet docs, phone-call exports, pasted notes).
import { findDate, parseClock, PHONE_RE, MEET_RE, renderTurns, speakerLabel, speakersOf, cleanTitle, type ParsedTranscript, type Turn } from "./common";

const CUE_RE = /^\s*((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)\s*-->\s*((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)/;

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
}

/** "Name: text" -> [Name, text] when Name looks like a speaker label. */
function splitSpeaker(line: string): [string | null, string] {
  const m = /^([^:]{1,40}):\s+(.*)$/.exec(line);
  if (m) {
    const name = speakerLabel(m[1]);
    if (name) return [name, m[2]];
  }
  return [null, line];
}

function empty(): ParsedTranscript {
  return { text: "", speakers: [], title: null, startedAt: null, durationSec: null, looksLikeMeet: false, looksLikePhone: false };
}

function finish(turns: Turn[], extra: Partial<ParsedTranscript>, raw: string): ParsedTranscript {
  // A speaker named once is carried forward until the next one (VTT cues often split a turn).
  return {
    ...empty(),
    text: renderTurns(turns),
    speakers: speakersOf(turns),
    looksLikeMeet: MEET_RE.test(raw.slice(0, 4000)),
    looksLikePhone: PHONE_RE.test(raw.slice(0, 2000)),
    ...extra,
  };
}

/**
 * WebVTT (.vtt: Zoom, Google Meet, Teams) and SubRip (.srt). Speakers come from `<v Name>` voice
 * tags or a "Name:" prefix; a cue with neither keeps the previous cue's speaker.
 */
export function parseCues(raw: string): ParsedTranscript {
  const lines = raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  const turns: Turn[] = [];
  let first: number | null = null, last: number | null = null;
  let current: string | null = null;
  let i = 0;
  // Skip the WEBVTT header block and NOTE / STYLE blocks.
  while (i < lines.length) {
    const cue = CUE_RE.exec(lines[i]);
    if (!cue) { i++; continue; }
    const start = parseClock(cue[1]), end = parseClock(cue[2]);
    if (start !== null && (first === null || start < first)) first = start;
    if (end !== null && (last === null || end > last)) last = end;
    i++;
    const textLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !CUE_RE.exec(lines[i])) textLines.push(lines[i++]);
    for (const tl of textLines) {
      const voice = /<v(?:\.[^\s>]+)?\s+([^>]+)>/.exec(tl);
      let speaker: string | null = voice ? voice[1].trim() : null;
      let text = stripTags(tl).trim();
      if (!speaker) {
        const [s, rest] = splitSpeaker(text);
        if (s) { speaker = s; text = rest; }
      }
      if (speaker) current = speaker;
      // A bare cue number left inside a block (SRT without blank lines) is not speech.
      if (/^\d+$/.test(text)) continue;
      turns.push({ speaker: current, text, at: start });
    }
  }
  return finish(turns, { durationSec: first !== null && last !== null ? Math.max(0, last - first) : null }, raw);
}

/**
 * Zoom's saved closed captions (meeting_saved_closed_caption.txt / closed_caption.txt). Two layouts:
 *   [Asha Rao] 10:02:13          (newer: name and local time, then the text on the next lines)
 *   10:02:13 From Asha Rao : text  (older: one line each)
 * Returns the first time of day it saw ("HH:MM:SS", local) so the caller can combine it with the date.
 */
export function parseZoomCaptions(raw: string): ParsedTranscript & { firstClock: string | null } {
  const lines = raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  const turns: Turn[] = [];
  let speaker: string | null = null;
  let firstClock: string | null = null, firstSec: number | null = null, lastSec: number | null = null;
  const seeClock = (c: string) => {
    const sec = parseClock(c);
    if (sec === null) return;
    if (firstClock === null) { firstClock = c; firstSec = sec; }
    lastSec = sec;
  };
  for (const line of lines) {
    const head = /^\s*\[([^\]]{1,60})\]\s+(\d{1,2}:\d{2}:\d{2})\s*$/.exec(line);
    if (head) { speaker = head[1].trim(); seeClock(head[2]); continue; }
    const old = /^\s*(\d{1,2}:\d{2}:\d{2})\s+From\s+(.+?)\s+:\s?(.*)$/.exec(line);
    if (old) { seeClock(old[1]); turns.push({ speaker: old[2].trim(), text: old[3] }); speaker = old[2].trim(); continue; }
    if (line.trim()) turns.push({ speaker, text: line });
  }
  let durationSec: number | null = null;
  if (firstSec !== null && lastSec !== null) durationSec = lastSec >= firstSec ? lastSec - firstSec : lastSec + 86400 - firstSec;
  return { ...finish(turns, { durationSec }, raw), firstClock };
}

/** True when a .txt looks like Zoom's saved captions rather than a general transcript. */
export function looksLikeZoomCaptions(raw: string): boolean {
  const head = raw.slice(0, 2000);
  return /^\s*\[[^\]]{1,60}\]\s+\d{1,2}:\d{2}:\d{2}\s*$/m.test(head) || /^\s*\d{1,2}:\d{2}:\d{2}\s+From\s+.+?\s+:/m.test(head);
}

/**
 * Plain text and Markdown: Google Meet transcript docs (as .txt or the text of a .docx), phone-call
 * exports (iOS Notes, Just Press Record), pasted transcripts. Line shapes it understands:
 *   Asha Rao: text            [00:01:02] Asha: text         00:01:02 Asha: text
 *   Asha (00:01:02): text     Asha 00:01:02  (then text)    00:01:02  (then "Asha: text")
 * Header lines ("Attendees", "Transcript", a title, a date line) are read for title and time and
 * kept out of the speech. Lines without a label belong to the last speaker, or to nobody.
 * `timeZone` reads wall-clock dates in the contents.
 */
export function parsePlain(raw: string, timeZone: string): ParsedTranscript {
  const text = raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const turns: Turn[] = [];
  let title: string | null = null;
  let startedAt: string | null = null;
  let speaker: string | null = null;
  let firstSec: number | null = null, lastSec: number | null = null;
  let inAttendees = false;
  let seenSpeech = false;
  const seeSec = (c: string) => {
    const s = parseClock(c);
    if (s === null) return;
    if (firstSec === null) firstSec = s;
    lastSec = s;
  };
  for (let n = 0; n < lines.length; n++) {
    let line = lines[n].trim();
    if (!line) { inAttendees = false; continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) continue;
    // Header area: title, date, attendees. Only before the first speech.
    if (!seenSpeech) {
      if (/^(attendees|participants|invited)\s*:?\s*$/i.test(line)) { inAttendees = true; continue; }
      // The attendee list runs until the transcript starts (a "Transcript" line, a timestamp or a speaker).
      if (inAttendees && !/^#?\s*transcript\s*:?$/i.test(line) && !/^\[?\d{1,2}:\d{2}/.test(line) && !splitSpeaker(line)[0]) continue;
      inAttendees = false;
      if (/^(attendees|participants|invited)\s*:/i.test(line)) continue;
      if (/^#?\s*transcript\s*:?$/i.test(line) || /^(meeting records|summary|notes)\s*$/i.test(line)) continue;
      const dateLine = /^(date|time|when|started|recorded|start time)\s*:\s*(.+)$/i.exec(line);
      if (dateLine) {
        startedAt ??= findDate(dateLine[2], timeZone)?.iso ?? null;
        continue;
      }
      const titleish = !splitSpeaker(line)[0] && line.length <= 120 && line.split(/\s+/).length <= 14 && /^[\p{Lu}\p{Lo}]/u.test(line) && !/[.?!]$/.test(line);
      if (!title && n < 6 && (/^#\s+/.test(line) || titleish)) {
        startedAt ??= findDate(line, timeZone)?.iso ?? null;
        const t = cleanTitle(line);
        if (t && !/^\d{4}[-/.]\d{2}[-/.]\d{2}/.test(t)) {
          title = t;
          // A heading, or a line that says it is a title ("... - Transcript", "(date)"), is not speech.
          // Anything else might be the first words of an unlabelled call: keep it in the text too.
          if (/^#\s+/.test(line) || /transcript|notes by gemini/i.test(line) || findDate(line, timeZone)) continue;
          turns.push({ speaker: null, text: line });
          continue;
        } else if (startedAt) continue;
      }
      if (!startedAt && n < 8) {
        const d = findDate(line, timeZone);
        if (d && line.length <= 60) { startedAt = d.iso; continue; }
      }
    }
    // Google Meet's closing lines are not speech.
    if (/^transcript ended after\b/i.test(line) || /^this editable transcript was computer generated/i.test(line)) continue;
    line = line.replace(/^[-*•]\s+/, "").replace(/^\*\*([^*]+)\*\*/, "$1");
    // "[00:01:02] Asha: text" / "00:01:02 Asha: text"
    const lead = /^\[?((?:\d{1,2}:)?\d{1,2}:\d{2})\]?\s+(.*)$/.exec(line);
    if (lead) { seeSec(lead[1]); line = lead[2]; }
    // A line that is only a timestamp ("00:01:02") separates blocks.
    if (/^\[?((?:\d{1,2}:)?\d{1,2}:\d{2})\]?$/.test(line)) { seeSec(line.replace(/[[\]]/g, "")); continue; }
    // "Asha (00:01:02): text"
    const paren = /^([^:()]{1,40})\s*\(((?:\d{1,2}:)?\d{1,2}:\d{2})\)\s*:?\s*(.*)$/.exec(line);
    if (paren && speakerLabel(paren[1])) {
      seeSec(paren[2]); speaker = speakerLabel(paren[1]); seenSpeech = true;
      if (paren[3]) turns.push({ speaker, text: paren[3] });
      continue;
    }
    // "Asha Rao 00:01:02" on its own line, the text follows.
    const head = /^([^:]{1,40}?)\s+((?:\d{1,2}:)?\d{1,2}:\d{2})$/.exec(line);
    if (head && speakerLabel(head[1])) { seeSec(head[2]); speaker = speakerLabel(head[1]); seenSpeech = true; continue; }
    const [s, rest] = splitSpeaker(line);
    if (s) { speaker = s; turns.push({ speaker, text: rest }); seenSpeech = true; continue; }
    turns.push({ speaker, text: line });
    seenSpeech = true;
  }
  const durationSec = firstSec !== null && lastSec !== null ? Math.max(0, (lastSec as number) - (firstSec as number)) : null;
  return finish(turns, { title, startedAt, durationSec }, text);
}
