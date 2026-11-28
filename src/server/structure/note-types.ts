// Note types for the current workspace: .daily-brief/note-types.json. Missing file: the defaults
// (Meeting note, Project, Person note), written only once you change them.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_TYPES, parseTypes, type NoteType, type NoteTypesFile } from "@/lib/structure/note-types";
import { dataDir } from "@/server/local/paths";

export const noteTypesPath = (dir = dataDir()) => join(dir, "note-types.json");

export interface LoadedTypes { types: NoteType[]; error: string | null; custom: boolean }

export function loadNoteTypes(dir = dataDir()): LoadedTypes {
  const p = noteTypesPath(dir);
  if (!existsSync(p)) return { types: DEFAULT_TYPES, error: null, custom: false };
  try {
    return { types: parseTypes(JSON.parse(readFileSync(p, "utf8"))), error: null, custom: true };
  } catch {
    return { types: DEFAULT_TYPES, error: "note-types.json couldn't be read, so the default types are used. Saving here writes a fresh one.", custom: true };
  }
}

export function saveNoteTypes(types: NoteType[], dir = dataDir()): NoteType[] {
  const clean = parseTypes({ version: 1, types });
  const p = noteTypesPath(dir);
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  const body: NoteTypesFile = { version: 1, types: clean };
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(body, null, 2) + "\n");
  renameSync(tmp, p);
  return clean;
}
