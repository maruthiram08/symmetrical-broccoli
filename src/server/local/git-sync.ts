// Git sync: when the notes folder is a git repo, commit the notes a brief wrote
// ("Daily brief 2026-11-26"), and push to a remote only when you turn that on. It runs your own
// git with your own credentials (keychain, SSH agent); the app stores a remote's name, never a URL
// or token, and git is never allowed to stop and ask for a password.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const GIT_TIMEOUT_MS = 30_000;
const PUSH_TIMEOUT_MS = 60_000;
export const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface GitRun { code: number; stdout: string; stderr: string }

export function git(dir: string, args: string[], timeout = GIT_TIMEOUT_MS): Promise<GitRun> {
  return new Promise((done) => {
    execFile("git", ["-C", dir, ...args], {
      timeout,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "", GCM_INTERACTIVE: "never", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes" },
    }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      done({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** True when the folder is inside a git work tree (and git is installed). */
export async function isGitRepo(dir: string): Promise<boolean> {
  if (!existsSync(dir)) return false;
  const r = await git(dir, ["rev-parse", "--is-inside-work-tree"]);
  return r.code === 0 && r.stdout.trim() === "true";
}

/** A short reason from git's error output, without URLs or anything that looks like a credential. */
export function gitReason(r: GitRun): string {
  const line = (r.stderr || r.stdout).split("\n").map((l) => l.trim()).filter(Boolean).find((l) => /^(fatal|error|hint|remote|!)/i.test(l))
    ?? (r.stderr || r.stdout).split("\n").map((l) => l.trim()).find(Boolean) ?? `git exited with ${r.code}`;
  return line.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>").replace(/\b(gh[pousr]_|github_pat_|glpat-)[A-Za-z0-9_-]+/g, "<token>").slice(0, 200);
}

export type CommitResult = { status: "committed"; commit: string } | { status: "nothing" } | { status: "failed"; reason: string };

/**
 * Commit these files (paths relative to `dir`) and only these, whatever else you have staged.
 * Missing files are skipped.
 */
export async function commitFiles(dir: string, files: string[], message: string): Promise<CommitResult> {
  const present = [...new Set(files)].filter((f) => existsSync(join(dir, f)));
  if (!present.length) return { status: "nothing" };
  const add = await git(dir, ["add", "--", ...present]);
  if (add.code !== 0) return { status: "failed", reason: gitReason(add) };
  const diff = await git(dir, ["diff", "--cached", "--quiet", "--", ...present]);
  if (diff.code === 0) return { status: "nothing" };
  const c = await git(dir, ["commit", "--no-verify", "-q", "-m", message, "--", ...present]);
  if (c.code !== 0) {
    const reason = /tell me who you are|user\.email|user\.name/i.test(c.stderr) ? "Git doesn't know your name and email yet: run git config --global user.name and user.email." : gitReason(c);
    return { status: "failed", reason };
  }
  const head = await git(dir, ["rev-parse", "--short", "HEAD"]);
  return { status: "committed", commit: head.stdout.trim() };
}

export type PushResult = { status: "pushed" } | { status: "failed"; reason: string };

/** Push the current branch to a named remote, with your git credentials. Never prompts. */
export async function pushTo(dir: string, remote: string): Promise<PushResult> {
  if (!REMOTE_NAME.test(remote)) return { status: "failed", reason: "Use a remote's name, like origin." };
  const known = await git(dir, ["remote"]);
  if (!known.stdout.split("\n").map((s) => s.trim()).includes(remote)) return { status: "failed", reason: `This repo has no remote called ${remote}.` };
  const branch = (await git(dir, ["symbolic-ref", "--short", "-q", "HEAD"])).stdout.trim();
  if (!branch) return { status: "failed", reason: "Not on a branch (detached HEAD), so nothing was pushed." };
  const r = await git(dir, ["push", "--porcelain", remote, `HEAD:refs/heads/${branch}`], PUSH_TIMEOUT_MS);
  return r.code === 0 ? { status: "pushed" } : { status: "failed", reason: gitReason(r) };
}
