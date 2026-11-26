// Shared by the hosted scripts: load KEY=value lines from a file (default .env.hosted, if it
// exists) into process.env, without overriding what is already set. Values are never printed.
import { existsSync, readFileSync } from "node:fs";

export function loadEnvFile(argv: string[]): string | null {
  const i = argv.indexOf("--env");
  const path = i >= 0 ? argv[i + 1] : ".env.hosted";
  if (!path || !existsSync(path)) {
    if (i >= 0) throw new Error(`No such env file: ${path}`);
    return null;
  }
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
  return path;
}
