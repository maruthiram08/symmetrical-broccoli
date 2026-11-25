import type { NextConfig } from "next";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

/** The commit this build came from, for Settings > Health. Empty outside a git checkout. */
function gitCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
}

const nextConfig: NextConfig = {
  // Pin the project root: a stray package.json in a parent folder (e.g. ~) would otherwise make
  // Next treat that folder as the root and package the wrong files into the standalone build.
  outputFileTracingRoot: root,
  env: {
    DAILY_BRIEF_VERSION: (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version,
    DAILY_BRIEF_COMMIT: gitCommit(),
  },
  // The Mac app (npm run mac:build) runs the self-contained server in .next/standalone with the
  // system Node. `npm start` and launchd keep using the normal build.
  ...(process.env.NEXT_OUTPUT_STANDALONE === "1" ? { output: "standalone" as const } : {}),
};

export default nextConfig;
