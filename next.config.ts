import type { NextConfig } from "next";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const nextConfig: NextConfig = {
  // Pin the project root: a stray package.json in a parent folder (e.g. ~) would otherwise make
  // Next treat that folder as the root and package the wrong files into the standalone build.
  outputFileTracingRoot: dirname(fileURLToPath(import.meta.url)),
  // The Mac app (npm run mac:build) runs the self-contained server in .next/standalone with the
  // system Node. `npm start` and launchd keep using the normal build.
  ...(process.env.NEXT_OUTPUT_STANDALONE === "1" ? { output: "standalone" as const } : {}),
};

export default nextConfig;
