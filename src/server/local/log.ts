import { copyFileSync, existsSync, renameSync, statSync, truncateSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The log the Mac app and the launchd agent point stdout/stderr at. Both open it in append mode,
 * so it can be rotated from inside the server with copy-then-truncate (the writer's next line lands
 * at the start of the emptied file). DAILY_BRIEF_LOG overrides it (tests, other setups).
 */
export function logPath(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): string {
  if (env.DAILY_BRIEF_LOG) return env.DAILY_BRIEF_LOG;
  // The same places the desktop app uses (src-tauri/src/main.rs, log_path).
  if (platform === "win32") return join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Daily Brief", "daily-brief.log");
  if (platform === "linux") return join(env.XDG_STATE_HOME ?? join(home, ".local", "state"), "daily-brief", "daily-brief.log");
  return join(home, "Library", "Logs", "daily-brief.log");
}

export const LOG_MAX_BYTES = 5 * 1024 * 1024;
export const LOG_KEEP = 3;

/**
 * Rotate `path` when it is larger than maxBytes: .2 -> .3, .1 -> .2, copy -> .1, truncate.
 * Keeps at most `keep` old files. Never throws (a log problem must not stop the app).
 * Returns true when it rotated.
 */
export function rotateLog(path: string = logPath(), maxBytes = LOG_MAX_BYTES, keep = LOG_KEEP): boolean {
  try {
    if (!existsSync(path) || statSync(path).size <= maxBytes) return false;
    const old = (n: number) => `${path}.${n}`;
    if (existsSync(old(keep))) unlinkSync(old(keep));
    for (let n = keep - 1; n >= 1; n--) if (existsSync(old(n))) renameSync(old(n), old(n + 1));
    copyFileSync(path, old(1));
    truncateSync(path, 0);
    return true;
  } catch {
    return false;
  }
}

/** Things that look like credentials. Replaced before anything reaches a log or the events list. */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, "[redacted]"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]"],
  [/\b(access_token|refresh_token|id_token|client_secret|code_verifier|api[_-]?key|x-api-key|authorization)(["']?\s*[:=]\s*["']?)[^\s"'&,}]+/gi, "$1$2[redacted]"],
  [/([?&]code=)[^\s&"']+/g, "$1[redacted]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, "[redacted]"], // JWTs
];

export function redact(s: string): string {
  let out = s;
  for (const [p, r] of SECRET_PATTERNS) out = out.replace(p, r);
  return out;
}

/** "Name: message" for a log line: one line, at most `max` chars, with secrets removed. */
export function errLine(e: unknown, opts: { message?: boolean; max?: number } = {}): string {
  if (!(e instanceof Error)) return typeof e === "string" && opts.message !== false ? redact(e).slice(0, opts.max ?? 200) : "Error";
  if (opts.message === false) return e.name;
  return `${e.name}: ${redact(e.message.replace(/\s+/g, " ")).slice(0, opts.max ?? 200)}`;
}
