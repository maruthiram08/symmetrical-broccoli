import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Mac app (npm run mac:build) runs the self-contained server in .next/standalone with the
  // system Node. `npm start` and launchd keep using the normal build.
  ...(process.env.NEXT_OUTPUT_STANDALONE === "1" ? { output: "standalone" as const } : {}),
};

export default nextConfig;
