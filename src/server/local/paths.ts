import { join } from "node:path";
import { currentWorkspace } from "./workspaces";

/**
 * Your notes folder: the current workspace's folder. Plain Markdown, one file per day, plus
 * decisions.md. With one workspace (the default) it is DAILY_BRIEF_DIR, else ~/Daily Brief.
 */
export function notesDir(): string {
  return currentWorkspace().path;
}
/** App data inside the notes folder: state.json and the local key. Hidden, 0700. */
export function dataDir(): string {
  return join(notesDir(), ".daily-brief");
}
export const PORT = Number(process.env.PORT ?? 4242);
export function appUrl(): string {
  return process.env.APP_URL ?? `http://localhost:${PORT}`;
}
