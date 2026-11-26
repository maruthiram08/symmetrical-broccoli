import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderDecisionsAppend } from "@/lib/brief/markdown";
import { carryNotes } from "@/lib/capture/notes";
import { routinesCount } from "@/lib/routines/brief";
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
  notify: Notify = osNotify,
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
  const r = routinesCount(m.routines);
  const plus = (s: string) => (r ? `${s} · ${r}` : s);
  if (m.empty === "no_meetings") return plus("No meetings today.");
  if (m.empty === "nothing_owed") return plus("Nothing owed. Go home.");
  const first = m.youOwe[0];
  return first ? plus(`${first.text}${first.lateLabel ? ` (${first.lateLabel})` : ""}`) : r ? `${r[0].toUpperCase()}${r.slice(1)}.` : "Open Daily brief to see your day.";
}

export type Notify = (title: string, body: string) => void;
type Run = (cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; windowsHide?: boolean; timeout?: number }, cb: () => void) => unknown;

const clip = (s: string) => s.slice(0, 200);

/** Windows toast through PowerShell's WinRT bridge. Title and body come in through env, never the script text. */
export const WINDOWS_TOAST_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
  "$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
  "$t = $x.GetElementsByTagName('text')",
  "$t.Item(0).AppendChild($x.CreateTextNode($env:DB_NOTIFY_TITLE)) > $null",
  "$t.Item(1).AppendChild($x.CreateTextNode($env:DB_NOTIFY_BODY)) > $null",
  "$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
  "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($x))",
].join("; ");

/**
 * A desktop notification on this computer. Never throws, never waits.
 * - macOS: osascript (Notification Center).
 * - Linux: notify-send (libnotify; most desktops have it).
 * - Windows: a toast through PowerShell.
 * Other systems: nothing.
 */
export function osNotify(title: string, body: string, platform: NodeJS.Platform = process.platform, run: Run = execFile as unknown as Run): void {
  try {
    if (platform === "darwin") {
      const q = (s: string) => JSON.stringify(clip(s)); // AppleScript strings use double quotes and backslash escapes
      run("osascript", ["-e", `display notification ${q(body)} with title "Daily brief" subtitle ${q(title)}`], {}, () => {});
    } else if (platform === "linux") {
      run("notify-send", ["--app-name=Daily brief", clip(title), clip(body)], { timeout: 10_000 }, () => {});
    } else if (platform === "win32") {
      run(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-Command", WINDOWS_TOAST_SCRIPT],
        { env: { ...process.env, DB_NOTIFY_TITLE: clip(title), DB_NOTIFY_BODY: clip(body) }, windowsHide: true, timeout: 20_000 },
        () => {},
      );
    }
  } catch {
    /* no notifier installed: the brief is still written */
  }
}

/** Kept for older imports: notifications now go through osNotify on every system. */
export const macNotify: Notify = (title, body) => osNotify(title, body);
