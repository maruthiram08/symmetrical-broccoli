import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderDecisionsAppend } from "@/lib/brief/markdown";
import type { BriefModel, User } from "@/lib/types";

/**
 * Deliver a brief on this Mac: write YYYY-MM-DD.md, append today's decisions to decisions.md
 * (once per day), and show a notification. Returns the note's path.
 */
export async function publishLocal(
  dir: string,
  _user: User,
  model: BriefModel,
  markdown: string,
  notify: (title: string, body: string) => void = macNotify,
): Promise<{ id: string }> {
  mkdirSync(dir, { recursive: true });
  const notePath = join(dir, `${model.date}.md`);
  writeFileSync(notePath, markdown);

  const decisions = renderDecisionsAppend(model);
  const decisionsPath = join(dir, "decisions.md");
  const already = existsSync(decisionsPath) && readFileSync(decisionsPath, "utf8").includes(`- ${model.date} · `);
  if (decisions && !already) {
    if (!existsSync(decisionsPath)) writeFileSync(decisionsPath, "# Decisions\n\n");
    appendFileSync(decisionsPath, decisions);
  }

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
