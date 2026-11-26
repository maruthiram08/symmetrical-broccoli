// Copies the Anthropic API key from .env.local into the system's secret store for the desktop app
// (macOS Keychain, Windows Credential Manager, or the Linux keyring through secret-tool), and the
// non-secret settings (EXTRACTION_MODEL, WISPR_MCP_URL, PHONE_*) into <data>/settings.env.
// The Wispr Flow token key (<data>/key) moves into the system keychain by itself on the app's first start.
// Run: npm run keychain:import   (never prints a secret)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KEYCHAIN_SERVICE, osKeychain } from "../src/server/local/keychain";
import { dataDir } from "../src/server/local/paths";
import { settingsPath } from "../src/server/local/secrets";

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

const byHand = (): string =>
  process.platform === "win32"
    ? `  cmdkey /generic:${KEYCHAIN_SERVICE}:ANTHROPIC_API_KEY /user:ANTHROPIC_API_KEY /pass`
    : process.platform === "linux"
      ? `  secret-tool store --label="Daily brief ANTHROPIC_API_KEY" service ${KEYCHAIN_SERVICE} account ANTHROPIC_API_KEY`
      : `  security add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ANTHROPIC_API_KEY -w`;

const macKeychain = osKeychain();

async function main() {
  if (!macKeychain.available()) {
    console.log(process.platform === "linux" ? "No secret-tool here. Install libsecret-tools (sudo apt install libsecret-tools), then run this again." : "No system keychain here. Nothing to do.");
    return;
  }
  const envPath = join(process.cwd(), ".env.local");
  const vars = existsSync(envPath) ? parseEnv(readFileSync(envPath, "utf8")) : {};

  const key = vars.ANTHROPIC_API_KEY;
  const current = await macKeychain.read("ANTHROPIC_API_KEY");
  if (key) {
    if (current === key) console.log(`ANTHROPIC_API_KEY is already in the system keychain (service ${KEYCHAIN_SERVICE}).`);
    else if (await macKeychain.write("ANTHROPIC_API_KEY", key)) console.log(`Saved ANTHROPIC_API_KEY to the system keychain (service ${KEYCHAIN_SERVICE}).`);
    else {
      console.error("Couldn't save ANTHROPIC_API_KEY to the system keychain. Add it by hand (it asks for the key):");
      console.error(byHand());
      process.exitCode = 1;
    }
    console.log("You can now remove ANTHROPIC_API_KEY from .env.local; npm start falls back to the system keychain.");
  } else if (current) {
    console.log("ANTHROPIC_API_KEY is already in the system keychain.");
  } else {
    console.log("No ANTHROPIC_API_KEY in .env.local. Add it to the system keychain by hand (it asks for the key):");
    console.log(byHand());
  }

  const settings = ["EXTRACTION_MODEL", "WISPR_MCP_URL", "PHONE_BIND", "PHONE_PORT", "PHONE_HOSTNAME", "PHONE_TLS_CERT", "PHONE_TLS_KEY"].filter((k) => vars[k]);
  if (settings.length) {
    mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
    const p = settingsPath();
    const existing = existsSync(p) ? parseEnv(readFileSync(p, "utf8")) : {};
    for (const k of settings) existing[k] = vars[k];
    writeFileSync(p, Object.entries(existing).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
    console.log(`Saved ${settings.join(", ")} to ${p}.`);
  }
}

void main();
