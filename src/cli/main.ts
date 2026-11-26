// Entry point for the daily-brief command (bin/daily-brief runs this with tsx).
// Opens the same state.json as the app (honouring DAILY_BRIEF_DIR) and runs one command.

import { execFile } from "node:child_process";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { env } from "@/lib/env";
import { FileStore } from "@/server/local/file-store";
import { macKeychain } from "@/server/local/keychain";
import { appUrl, dataDir } from "@/server/local/paths";
import { run } from "./commands";
import { makeStyle, wantColor } from "./style";

/** The Anthropic key from the environment, else the app's Keychain entry (Mac). Never printed. */
async function anthropic() {
  let key = process.env.ANTHROPIC_API_KEY;
  if (!key && macKeychain.available()) key = (await macKeychain.read("ANTHROPIC_API_KEY")) ?? undefined;
  if (!key) return null;
  return { client: new Anthropic({ apiKey: key, maxRetries: 1, timeout: 60_000 }), model: env.extractionModel };
}

/** `open` on a Mac, xdg-open elsewhere. */
function openUrl(url: string): Promise<boolean> {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  return new Promise((resolve) => execFile(cmd, [url], { timeout: 10_000 }, (err) => resolve(!err)));
}

async function main() {
  const argv = process.argv.slice(2);
  const color = wantColor(process.stdout, process.env, argv.includes("--no-color") ? false : argv.includes("--color") ? true : undefined);
  const style = makeStyle({ color, width: process.stdout.isTTY ? Math.min(process.stdout.columns || 100, 120) : null });
  const store = new FileStore(join(dataDir(), "state.json"));
  const code = await run(argv, {
    store,
    style,
    appUrl: appUrl(),
    out: (s) => { process.stdout.write(s.endsWith("\n") ? s : s + "\n"); },
    err: (s) => { process.stderr.write((color ? `\x1b[31m${s}\x1b[39m` : s) + "\n"); },
    stream: process.stdout.isTTY && !argv.includes("--json") ? (t) => { process.stdout.write(t); } : undefined,
    open: openUrl,
    ai: anthropic,
  });
  process.exitCode = code;
}

main().catch((e) => {
  process.stderr.write(`daily-brief: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
