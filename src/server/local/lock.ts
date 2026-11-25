import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";

export interface LockInfo {
  pid: number;
  host: string;
  startedAt: string;
  /** Refreshed about every minute while the holder runs. */
  heartbeatAt: string;
}

/** No heartbeat for this long: the holder is gone (or the Mac slept), and another copy may take over. */
export const LOCK_STALE_MS = 10 * 60_000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists, but not ours to signal
  }
}

/**
 * A lock file in the data folder so only one Daily brief process runs the scheduler, even when the
 * launchd agent and the Mac app (or a stray `npm start`) both run against the same state.json.
 *
 * The holder calls tryAcquire() on every heartbeat and tick: it refreshes the heartbeat, or returns
 * false if another process took the lock over (then it stops running jobs). A lock is stale, and
 * may be taken over, when its process is gone or its heartbeat is older than LOCK_STALE_MS (which
 * also covers a pid reused by an unrelated process after a restart).
 */
export class SchedulerLock {
  private readonly pid: number;
  private readonly now: () => number;
  private readonly alive: (pid: number) => boolean;
  private readonly staleMs: number;
  private readonly startedAt: string;

  constructor(
    readonly path: string,
    opts: { pid?: number; now?: () => number; isAlive?: (pid: number) => boolean; staleMs?: number } = {},
  ) {
    this.pid = opts.pid ?? process.pid;
    this.now = opts.now ?? Date.now;
    this.alive = opts.isAlive ?? pidAlive;
    this.staleMs = opts.staleMs ?? LOCK_STALE_MS;
    this.startedAt = new Date(this.now()).toISOString();
  }

  /** The current holder, or null when there is no readable lock. */
  holder(): LockInfo | null {
    try {
      const v = JSON.parse(readFileSync(this.path, "utf8")) as LockInfo;
      return typeof v.pid === "number" && typeof v.heartbeatAt === "string" ? v : null;
    } catch {
      return null;
    }
  }

  isStale(info: LockInfo | null): boolean {
    if (!info) return true;
    if (info.host !== hostname()) return this.now() - Date.parse(info.heartbeatAt) > this.staleMs;
    return !this.alive(info.pid) || this.now() - Date.parse(info.heartbeatAt) > this.staleMs;
  }

  /** Take or keep the lock. True when this process holds it afterwards. Never throws. */
  tryAcquire(): boolean {
    try {
      const cur = this.holder();
      if (cur && cur.pid === this.pid && cur.host === hostname()) {
        this.write(false);
        return true;
      }
      if (existsSync(this.path) && !this.isStale(cur)) return false;
      if (existsSync(this.path)) unlinkSync(this.path);
      if (!this.write(true)) return false; // someone else created it first
      return this.holder()?.pid === this.pid;
    } catch {
      return false;
    }
  }

  /** Remove the lock if this process holds it. */
  release(): void {
    try {
      const cur = this.holder();
      if (cur && cur.pid === this.pid && cur.host === hostname()) unlinkSync(this.path);
    } catch {
      // already gone
    }
  }

  private info(): LockInfo {
    return { pid: this.pid, host: hostname(), startedAt: this.startedAt, heartbeatAt: new Date(this.now()).toISOString() };
  }

  /** exclusive: create only if absent (O_EXCL). Otherwise replace atomically. */
  private write(exclusive: boolean): boolean {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    // Written whole to a temp file first, so a reader never sees an empty lock.
    const tmp = `${this.path}.${this.pid}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try { writeSync(fd, JSON.stringify(this.info())); } finally { closeSync(fd); }
    if (!exclusive) {
      renameSync(tmp, this.path);
      return true;
    }
    try {
      linkSync(tmp, this.path); // fails if the lock exists: only one creator wins
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    } finally {
      unlinkSync(tmp);
    }
  }
}
