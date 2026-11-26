import { extname } from "node:path";
import { docxToText } from "./docx";
import { looksLikeZoomCaptions, parseCues, parsePlain, parseZoomCaptions } from "./formats";
import type { ParsedTranscript } from "./common";

export type { ParsedTranscript } from "./common";

/** File types a transcript can come in. */
export const TRANSCRIPT_EXTS = [".vtt", ".srt", ".txt", ".md", ".docx"] as const;

export function isTranscriptFile(name: string): boolean {
  return !name.startsWith(".") && !name.startsWith("~$") && (TRANSCRIPT_EXTS as readonly string[]).includes(extname(name).toLowerCase());
}

/** Parse a transcript file's bytes by its extension. Throws on a broken .docx. */
export function parseTranscriptBytes(name: string, buf: Buffer, timeZone: string): ParsedTranscript {
  const ext = extname(name).toLowerCase();
  if (ext === ".vtt" || ext === ".srt") return parseCues(buf.toString("utf8"));
  if (ext === ".docx") return parsePlain(docxToText(buf), timeZone);
  const text = buf.toString("utf8");
  if (ext === ".txt" && looksLikeZoomCaptions(text)) return parseZoomCaptions(text);
  return parsePlain(text, timeZone);
}
