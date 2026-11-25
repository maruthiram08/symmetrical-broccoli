import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import type { Connection, Health, Meeting } from "@/lib/types";
import { isSetAside } from "@/server/jobs/process";
import type { Recovery } from "./file-store";

/** No good poll for this long while polls fail: tell the user Wispr Flow can't be reached. */
export const WISPR_UNREACHABLE_MS = 2 * 60 * 60_000;

export type Alert =
  | { kind: "recovered"; from: string | null; corruptFile: string | null; at: string }
  | { kind: "wispr_reconnect" }
  | { kind: "wispr_unreachable"; since: string }
  | { kind: "anthropic_auth" }
  | { kind: "anthropic_credit" }
  | { kind: "meetings_failed"; count: number };

/**
 * The banners every page shows, most urgent first. Each one says what is wrong and what to do.
 * Pure, so it can be tested without a page.
 */
export function alertsFor(a: {
  conn: Connection | null;
  health: Health;
  recovery: Recovery | null;
  meetings: Array<Pick<Meeting, "processedAt" | "failedAttempts">>;
  now: Date;
}): Alert[] {
  const out: Alert[] = [];
  if (a.recovery) out.push({ kind: "recovered", from: a.recovery.from, corruptFile: a.recovery.corruptFile, at: a.recovery.at });
  if (a.conn?.status === "needs_reconnect") out.push({ kind: "wispr_reconnect" });
  else if (a.conn && a.health.lastPollErrorAt && (!a.health.lastPollOkAt || a.health.lastPollErrorAt > a.health.lastPollOkAt)) {
    const since = a.health.lastPollOkAt ?? null;
    if (since && a.now.getTime() - Date.parse(since) > WISPR_UNREACHABLE_MS) out.push({ kind: "wispr_unreachable", since });
  }
  const p = a.health.anthropicProblem;
  if (p) out.push({ kind: p.kind === "auth" ? "anthropic_auth" : "anthropic_credit" });
  const failed = a.meetings.filter((m) => !m.processedAt && isSetAside(m)).length;
  if (failed) out.push({ kind: "meetings_failed", count: failed });
  return out;
}

/** True when reading meetings is blocked on the user, so a progress bar would only spin. */
export function readingBlocked(alerts: Alert[]): boolean {
  return alerts.some((x) => x.kind === "wispr_reconnect" || x.kind === "anthropic_auth" || x.kind === "anthropic_credit");
}

export interface HealthSummary {
  lastPollOkAt: string | null;
  lastExtractOkAt: string | null;
  lastBriefAt: string | null;
  errors24h: number;
  /** "poll 2 · process 1" */
  errorsByJob: Array<[string, number]>;
  lastErrorAt: string | null;
  dataBytes: number | null;
  version: string;
}

export function summarizeHealth(a: {
  health: Health;
  events: Array<Record<string, unknown>>;
  statePath: string;
  now: Date;
  version?: string;
}): HealthSummary {
  const since = new Date(a.now.getTime() - 24 * 60 * 60_000).toISOString();
  const errors = a.events.filter((e) => e.type === "job_error" && typeof e.at === "string" && e.at >= since);
  const byJob = new Map<string, number>();
  for (const e of errors) {
    const job = String((e.payload as { job?: unknown } | undefined)?.job ?? "other");
    byJob.set(job, (byJob.get(job) ?? 0) + 1);
  }
  const lastOf = (type: string) => {
    const at = a.events.filter((e) => e.type === type && typeof e.at === "string").map((e) => e.at as string).sort().pop();
    return at ?? null;
  };
  return {
    lastPollOkAt: a.health.lastPollOkAt ?? null,
    lastExtractOkAt: a.health.lastExtractOkAt ?? lastOf("extract_run"),
    lastBriefAt: a.health.lastBriefAt ?? lastOf("brief_sent"),
    errors24h: errors.length,
    errorsByJob: [...byJob.entries()].sort((x, y) => y[1] - x[1]),
    lastErrorAt: errors.map((e) => e.at as string).sort().pop() ?? null,
    dataBytes: existsSync(a.statePath) ? statSync(a.statePath).size : null,
    version: a.version ?? appVersion(),
  };
}

let cachedVersion: string | null = null;

/** "0.1.0 (abc1234)": the package version and, when known, the git commit it was built from. */
export function appVersion(): string {
  if (cachedVersion) return cachedVersion;
  const version = process.env.DAILY_BRIEF_VERSION || process.env.npm_package_version || "0.1.0";
  let commit = process.env.DAILY_BRIEF_COMMIT || "";
  if (!commit) {
    try {
      commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: process.cwd(), timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    } catch {
      commit = "";
    }
  }
  cachedVersion = commit ? `${version} (${commit})` : version;
  return cachedVersion;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
