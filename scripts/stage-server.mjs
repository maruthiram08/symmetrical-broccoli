// Builds the Next server in standalone mode and stages it in build/app-server, where
// src-tauri/tauri.conf.json bundles it as the app's "server" resource. Cross-platform (used by
// .github/workflows/desktop.yml on macOS, Windows and Linux; scripts/mac-build.sh does the same on a Mac).
// Run: node scripts/stage-server.mjs
import { execSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

if (existsSync("node_modules") && lstatSync("node_modules").isSymbolicLink()) {
  console.error("node_modules is a symlink. Run npm install (or npm ci) in this folder first.");
  process.exit(1);
}

console.log("==> next build (standalone)");
rmSync(".next/standalone", { recursive: true, force: true });
execSync("npx next build", { stdio: "inherit", env: { ...process.env, NEXT_OUTPUT_STANDALONE: "1", NEXT_TELEMETRY_DISABLED: "1" } });

const stage = join("build", "app-server");
console.log(`==> staging the server in ${stage}`);
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(".next/standalone", stage, { recursive: true });
cpSync(".next/static", join(stage, ".next", "static"), { recursive: true });
if (existsSync("public")) cpSync("public", join(stage, "public"), { recursive: true });
// Never ship local env files: the app reads secrets from the system's secret store.
for (const f of readdirSync(stage)) if (f.startsWith(".env")) rmSync(join(stage, f), { force: true });
if (!existsSync(join(stage, "server.js"))) {
  console.error("No server.js in the standalone build.");
  process.exit(1);
}
console.log("Staged.");
