import { homedir } from "node:os";
import { join } from "node:path";

/** Your notes folder. Plain Markdown, one file per day, plus decisions.md. */
export function notesDir(): string {
  return process.env.DAILY_BRIEF_DIR ?? join(homedir(), "Daily Brief");
}
/** App data inside the notes folder: state.json and the local key. Hidden, 0700. */
export function dataDir(): string {
  return join(notesDir(), ".daily-brief");
}
export const PORT = Number(process.env.PORT ?? 4242);
export function appUrl(): string {
  return process.env.APP_URL ?? `http://localhost:${PORT}`;
}
