import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";

// macOS Keychain through Apple's own `security` tool. Items are created by /usr/bin/security, so
// reading them back never prompts, even after the app is rebuilt (its signature changes each build).
// Secret values never go on a command line (they would show in `ps`) and are never logged.

const SECURITY = "/usr/bin/security";
export const KEYCHAIN_SERVICE = "app.dailybrief";
/** CHANNEL_* names hold delivery secrets (src/server/channels/secrets.ts), base64url-encoded. */
export type SecretName = "ANTHROPIC_API_KEY" | "TOKEN_ENCRYPTION_KEY" | `CHANNEL_${string}` | IntegrationSecret;
/** Integration tokens and the local API / webhook secrets (src/server/integrations/vault.ts). */
export type IntegrationSecret = "JIRA_API_TOKEN" | "LINEAR_API_KEY" | "NOTION_TOKEN" | "TODOIST_TOKEN" | "LOCAL_API_TOKEN" | "WEBHOOK_SECRET";

/** API keys and base64 keys only. Anything else is refused rather than quoted. */
const SAFE_VALUE = /^[A-Za-z0-9+/=_.-]{8,512}$/;

export interface Keychain {
  available(): boolean;
  read(name: SecretName): Promise<string | null>;
  write(name: SecretName, value: string): Promise<boolean>;
  /** Delete a secret. Optional: fakes without it can't forget one. */
  remove?(name: SecretName): Promise<boolean>;
}

export const macKeychain: Keychain = {
  available: () => process.platform === "darwin" && existsSync(SECURITY),

  read(name) {
    return new Promise((resolve) => {
      execFile(SECURITY, ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", name, "-w"], { timeout: 15_000 }, (err, stdout) => {
        const v = String(stdout ?? "").trim();
        resolve(err || !v ? null : v);
      });
    });
  },

  async write(name, value) {
    if (!SAFE_VALUE.test(value)) return false;
    // `security -i` reads commands from stdin, which keeps the value out of the process list.
    const ok = await new Promise<boolean>((resolve) => {
      const p = spawn(SECURITY, ["-i"], { stdio: ["pipe", "ignore", "ignore"] });
      const t = setTimeout(() => p.kill(), 15_000);
      p.on("error", () => { clearTimeout(t); resolve(false); });
      p.on("close", (code) => { clearTimeout(t); resolve(code === 0); });
      p.stdin.end(`add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${name} -w ${value}\n`);
    });
    return ok && (await macKeychain.read(name)) === value;
  },

  remove(name) {
    return new Promise((resolve) => {
      execFile(SECURITY, ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", name], { timeout: 15_000 }, (err) => resolve(!err));
    });
  },
};

/** Whether a value can go in the Keychain (see SAFE_VALUE). */
export const safeSecret = (value: string) => SAFE_VALUE.test(value);

/** Set by the Mac app when it starts the server: secrets come from the Keychain, not files. */
export type Env = Record<string, string | undefined>;

export function keychainMode(kc: Keychain = macKeychain, env: Env = process.env): boolean {
  return env.DAILY_BRIEF_KEYCHAIN === "1" && kc.available();
}
