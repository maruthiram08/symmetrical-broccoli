import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keychainMode, macKeychain, type Env, type Keychain } from "./keychain";
import { homeDataDir as dataDir } from "./workspaces";
// Secrets and settings.env are shared by every workspace: they live in the home folder's .daily-brief/.

/** Non-secret settings the app reads from <data>/settings.env, since it has no .env.local. */
const SETTINGS = ["EXTRACTION_MODEL", "WISPR_MCP_URL"] as const;

export function settingsPath(): string {
  return join(dataDir(), "settings.env");
}

function loadSettings(env: Env): void {
  const p = settingsPath();
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && (SETTINGS as readonly string[]).includes(m[1]) && !env[m[1]]) env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
}

/**
 * Fills ANTHROPIC_API_KEY and TOKEN_ENCRYPTION_KEY before the app serves anything.
 * - Under the Mac app (DAILY_BRIEF_KEYCHAIN=1): both come from the Keychain. An existing
 *   <data>/key file is moved into the Keychain and deleted; a missing key is generated there.
 * - Otherwise (npm start, launchd, dev): .env.local and <data>/key as before. On a Mac, a value
 *   missing from both falls back to the Keychain, so dev keeps working after the move.
 * Never logs a value. Returns where each one came from, for tests.
 */
export async function loadSecrets(kc: Keychain = macKeychain, env: Env = process.env): Promise<Record<string, string>> {
  const from: Record<string, string> = {};
  const app = keychainMode(kc, env);
  if (app) loadSettings(env);

  if (env.ANTHROPIC_API_KEY) from.ANTHROPIC_API_KEY = "env";
  else if (kc.available()) {
    const v = await kc.read("ANTHROPIC_API_KEY");
    if (v) { env.ANTHROPIC_API_KEY = v; from.ANTHROPIC_API_KEY = "keychain"; }
  }

  const file = join(dataDir(), "key");
  if (env.TOKEN_ENCRYPTION_KEY) from.TOKEN_ENCRYPTION_KEY = "env";
  else if (app) {
    let v = await kc.read("TOKEN_ENCRYPTION_KEY");
    if (v) from.TOKEN_ENCRYPTION_KEY = "keychain";
    else {
      const fromFile = existsSync(file) ? readFileSync(file, "utf8").trim() : null;
      const next = fromFile ?? randomBytes(32).toString("base64");
      if (await kc.write("TOKEN_ENCRYPTION_KEY", next)) {
        if (fromFile) unlinkSync(file);
        v = next;
        from.TOKEN_ENCRYPTION_KEY = fromFile ? "moved-to-keychain" : "new-in-keychain";
      } else {
        console.error("[secrets] Couldn't write to the Keychain; keeping the local key file.");
        if (!fromFile) {
          mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
          writeFileSync(file, next, { mode: 0o600 });
        }
        v = next;
        from.TOKEN_ENCRYPTION_KEY = "file";
      }
    }
    env.TOKEN_ENCRYPTION_KEY = v;
  } else if (!existsSync(file) && kc.available()) {
    const v = await kc.read("TOKEN_ENCRYPTION_KEY");
    if (v) { env.TOKEN_ENCRYPTION_KEY = v; from.TOKEN_ENCRYPTION_KEY = "keychain"; }
  }
  return from;
}
