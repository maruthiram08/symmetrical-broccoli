import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";

// macOS Keychain through Apple's own `security` tool. Items are created by /usr/bin/security, so
// reading them back never prompts, even after the app is rebuilt (its signature changes each build).
// Secret values never go on a command line (they would show in `ps`) and are never logged.

const SECURITY = "/usr/bin/security";
export const KEYCHAIN_SERVICE = "app.dailybrief";
export type SecretName = "ANTHROPIC_API_KEY" | "TOKEN_ENCRYPTION_KEY";

/** API keys and base64 keys only. Anything else is refused rather than quoted. */
const SAFE_VALUE = /^[A-Za-z0-9+/=_.-]{8,512}$/;

export interface Keychain {
  available(): boolean;
  read(name: SecretName): Promise<string | null>;
  write(name: SecretName, value: string): Promise<boolean>;
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
};

// ---------- Linux and Windows ----------

/** Runs a command with optional stdin. Resolves with its exit code and stdout; never rejects. */
export type Runner = (cmd: string, args: string[], opts?: { input?: string; env?: NodeJS.ProcessEnv }) => Promise<{ code: number; stdout: string }>;

export const runCommand: Runner = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    let out = "";
    let p: ReturnType<typeof spawn>;
    try {
      p = spawn(cmd, args, { stdio: ["pipe", "pipe", "ignore"], env: opts.env ?? process.env, windowsHide: true });
    } catch {
      resolve({ code: -1, stdout: "" });
      return;
    }
    const t = setTimeout(() => p.kill(), 15_000);
    p.stdout?.on("data", (d: Buffer) => { out += d.toString("utf8"); });
    p.on("error", () => { clearTimeout(t); resolve({ code: -1, stdout: "" }); });
    p.on("close", (code) => { clearTimeout(t); resolve({ code: code ?? -1, stdout: out }); });
    p.stdin?.end(opts.input ?? "");
  });

const SECRET_TOOL_PATHS = ["/usr/bin/secret-tool", "/usr/local/bin/secret-tool", "/bin/secret-tool"];

/**
 * Linux: the desktop keyring (GNOME Keyring, KWallet) through libsecret's `secret-tool`
 * (package libsecret-tools). The value goes in on stdin, never on the command line.
 */
export function linuxKeychain(run: Runner = runCommand, tool = SECRET_TOOL_PATHS.find((p) => existsSync(p)) ?? null): Keychain {
  const attrs = (name: SecretName) => ["service", KEYCHAIN_SERVICE, "account", name];
  const kc: Keychain = {
    available: () => process.platform === "linux" && !!tool,
    async read(name) {
      if (!tool) return null;
      const r = await run(tool, ["lookup", ...attrs(name)]);
      const v = r.stdout.trim();
      return r.code === 0 && v ? v : null;
    },
    async write(name, value) {
      if (!tool || !SAFE_VALUE.test(value)) return false;
      const r = await run(tool, ["store", `--label=Daily brief ${name}`, ...attrs(name)], { input: value });
      return r.code === 0 && (await kc.read(name)) === value;
    },
  };
  return kc;
}

/**
 * Windows: Credential Manager (generic credentials named app.dailybrief:<NAME>) through
 * PowerShell and advapi32's CredRead/CredWrite. Names come in through env and the value on stdin.
 */
export const WINDOWS_CRED_TYPE = `
using System; using System.Runtime.InteropServices; using System.Text;
public static class DbCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct CREDENTIAL { public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;
    public int Persist; public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredReadW(string target, int type, int flags, out IntPtr cred);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredWriteW(ref CREDENTIAL cred, int flags);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr cred);
  public static string Read(string t) { IntPtr p; if (!CredReadW(t, 1, 0, out p)) return null;
    try { var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL)); return Marshal.PtrToStringUni(c.CredentialBlob, c.CredentialBlobSize / 2); } finally { CredFree(p); } }
  public static bool Write(string t, string user, string v) { var b = Encoding.Unicode.GetBytes(v); var c = new CREDENTIAL();
    c.Type = 1; c.TargetName = t; c.UserName = user; c.Persist = 2; c.CredentialBlobSize = b.Length; c.CredentialBlob = Marshal.AllocHGlobal(b.Length);
    try { Marshal.Copy(b, 0, c.CredentialBlob, b.Length); return CredWriteW(ref c, 0); } finally { Marshal.FreeHGlobal(c.CredentialBlob); } }
}`;

const psPrelude = `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition $env:DB_CRED_TYPE; `;
export const WINDOWS_READ = psPrelude + `$v = [DbCred]::Read($env:DB_CRED_TARGET); if ($v) { [Console]::Out.Write($v) } else { exit 1 }`;
export const WINDOWS_WRITE = psPrelude + `$v = [Console]::In.ReadToEnd(); if ([DbCred]::Write($env:DB_CRED_TARGET, $env:DB_CRED_ACCOUNT, $v)) { exit 0 } else { exit 1 }`;

export function windowsKeychain(run: Runner = runCommand): Keychain {
  const ps = (script: string, name: SecretName, input?: string) =>
    run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
      input,
      env: { ...process.env, DB_CRED_TYPE: WINDOWS_CRED_TYPE, DB_CRED_TARGET: `${KEYCHAIN_SERVICE}:${name}`, DB_CRED_ACCOUNT: name },
    });
  const kc: Keychain = {
    available: () => process.platform === "win32",
    async read(name) {
      const r = await ps(WINDOWS_READ, name);
      const v = r.stdout.trim();
      return r.code === 0 && v ? v : null;
    },
    async write(name, value) {
      if (!SAFE_VALUE.test(value)) return false;
      const r = await ps(WINDOWS_WRITE, name, value);
      return r.code === 0 && (await kc.read(name)) === value;
    },
  };
  return kc;
}

/** This system's secret store: macOS Keychain, Windows Credential Manager, or the Linux keyring. */
export function osKeychain(platform: NodeJS.Platform = process.platform): Keychain {
  if (platform === "win32") return windowsKeychain();
  if (platform === "linux") return linuxKeychain();
  return macKeychain;
}

/** Set by the desktop app when it starts the server: secrets come from the system's secret store, not files. */
export type Env = Record<string, string | undefined>;

export function keychainMode(kc: Keychain = osKeychain(), env: Env = process.env): boolean {
  return env.DAILY_BRIEF_KEYCHAIN === "1" && kc.available();
}
