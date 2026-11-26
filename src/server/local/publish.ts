import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderDecisionsAppend } from "@/lib/brief/markdown";
import { carryNotes } from "@/lib/capture/notes";
import type { BriefModel, User } from "@/lib/types";

/** The weekly recap handed over on Fridays: written as week-YYYY-Www.md. */
export interface WeekNote { key: string; markdown: string }

/**
 * Deliver a brief on this Mac: write YYYY-MM-DD.md, append today's decisions to decisions.md
 * (once per day), write the weekly recap when given one, and show a notification. Returns the note's path.
 */
export async function publishLocal(
  dir: string,
  _user: User,
  model: BriefModel,
  markdown: string,
  notify: (title: string, body: string) => void = macNotify,
  week?: WeekNote,
  /** decisions.md lines to append (linked ones from the workspace's settings); defaults to the plain ones. */
  decisionLines?: string,
): Promise<{ id: string }> {
  mkdirSync(dir, { recursive: true });
  const notePath = join(dir, `${model.date}.md`);
  // Your notes section (written from the day page) survives the brief being written again.
  writeFileSync(notePath, carryNotes(markdown, existsSync(notePath) ? readFileSync(notePath, "utf8") : null));

  const decisions = decisionLines ?? renderDecisionsAppend(model);
  const decisionsPath = join(dir, "decisions.md");
  const log = existsSync(decisionsPath) ? readFileSync(decisionsPath, "utf8") : "";
  const already = log.includes(`- ${model.date} · `) || log.includes(`- [[${model.date}]] · `);
  if (decisions && !already) {
    if (!existsSync(decisionsPath)) writeFileSync(decisionsPath, "# Decisions\n\n");
    appendFileSync(decisionsPath, decisions);
  }

  if (week) writeFileSync(join(dir, `week-${week.key}.md`), week.markdown);

  notify(model.subject, notificationBody(model));
  return { id: notePath };
}

export function notificationBody(m: BriefModel): string {
  if (m.empty === "no_meetings") return "No meetings today.";
  if (m.empty === "nothing_owed") return "Nothing owed. Go home.";
  const first = m.youOwe[0];
  return first ? `${first.text}${first.lateLabel ? ` (${first.lateLabel})` : ""}` : "Open Daily brief to see your day.";
}

/** macOS notification through osascript. Does nothing on other systems. Never throws. */
export function macNotify(title: string, body: string): void {
  if (process.platform !== "darwin") return;
  const q = (s: string) => JSON.stringify(s.slice(0, 200)); // AppleScript strings use double quotes and backslash escapes
  execFile("osascript", ["-e", `display notification ${q(body)} with title "Daily brief" subtitle ${q(title)}`], () => {});
}
