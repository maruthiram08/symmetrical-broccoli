import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtractionInput, ExtractionResult } from "@/lib/types";
import { extractionCostInr, extractWithPrefs } from "./extract-local";
import { getFlash, setFlash } from "./flash";
import { linuxKeychain, osKeychain, windowsKeychain, WINDOWS_READ, WINDOWS_WRITE, macKeychain, type Runner } from "./keychain";
import { logPath } from "./log";
import { PhoneStore } from "./phone";
import { REMOTE_HEADER } from "./phone-proxy";
import { extractionModelName, extractionPrefs, saveExtractionPrefs, validOllamaUrl } from "./prefs";
import { osNotify, WINDOWS_TOAST_SCRIPT } from "./publish";
import { widgetAllowed } from "./widget-auth";

const tmp = () => join(mkdtempSync(join(tmpdir(), "db-plat-")), "x.json");

describe("reading model preference", () => {
  afterEach(() => { delete process.env.EXTRACTION_MODEL; });

  it("defaults to Claude and keeps the Ollama choice", () => {
    const p = tmp();
    expect(extractionPrefs(p).provider).toBe("claude");
    expect(extractionModelName(extractionPrefs(p))).toBe("claude-sonnet-5-5");
    saveExtractionPrefs({ provider: "ollama", ollamaModel: "llama3.1:8b", ollamaUrl: "http://127.0.0.1:11434" }, p);
    expect(extractionPrefs(p)).toEqual({ provider: "ollama", ollamaModel: "llama3.1:8b", ollamaUrl: "http://127.0.0.1:11434" });
    expect(extractionModelName(extractionPrefs(p))).toBe("ollama:llama3.1:8b");
  });

  it("only accepts plain http(s) addresses", () => {
    expect(validOllamaUrl("http://127.0.0.1:11434/api")).toBe("http://127.0.0.1:11434");
    expect(validOllamaUrl("http://user:pw@host:1")).toBeNull();
    expect(validOllamaUrl("file:///etc/passwd")).toBeNull();
    expect(validOllamaUrl("nonsense")).toBeNull();
  });

  it("routes a read to Claude or Ollama, and a local read costs nothing", async () => {
    const result: ExtractionResult = { newItems: [], closes: [], usage: { inputTokens: 1, outputTokens: 1 } };
    const claude = vi.fn(async () => result);
    const input = { transcript: "x", user: { name: "M", aliases: [], timeZone: "UTC" }, meeting: { title: "t", startedAt: "2026-11-26T00:00:00Z", participants: [] }, openItems: [] } as ExtractionInput;
    await extractWithPrefs(input, { provider: "claude", ollamaModel: "m", ollamaUrl: "http://x" }, { claude });
    expect(claude).toHaveBeenCalledTimes(1);
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ message: { content: '{"newItems":[],"closes":[]}' } }), text: async () => "" }));
    await extractWithPrefs(input, { provider: "ollama", ollamaModel: "m", ollamaUrl: "http://x" }, { claude, fetch });
    expect(claude).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(extractionCostInr("ollama:m", { inputTokens: 5000, outputTokens: 500 })).toBe(0);
    expect(extractionCostInr("claude-sonnet-5-5", { inputTokens: 1_000_000, outputTokens: 0 })).toBeGreaterThan(0);
  });
});

describe("widget access", () => {
  const h = (o: Record<string, string>) => new Headers(o);
  it("needs a token, a paired phone, or the Mac's menu bar", () => {
    const phone = new PhoneStore(tmp());
    const { token, device } = phone.createWidgetToken();
    expect(widgetAllowed(h({}), phone)).toBe(false);
    expect(widgetAllowed(h({ authorization: `Bearer ${token}` }), phone)).toBe(true);
    expect(widgetAllowed(h({ authorization: "Bearer nope", "x-daily-brief": "tray" }), phone)).toBe(false);
    expect(widgetAllowed(h({ "x-daily-brief": "tray" }), phone)).toBe(true);
    expect(widgetAllowed(h({ "x-daily-brief": "tray", [REMOTE_HEADER]: "public" }), phone)).toBe(false);
    expect(widgetAllowed(h({ [REMOTE_HEADER]: device.id }), phone)).toBe(true);
    expect(widgetAllowed(h({ [REMOTE_HEADER]: "unknown" }), phone)).toBe(false);
  });
});

describe("secrets per system", () => {
  function fakeRunner(store: Map<string, string>) {
    const calls: Array<{ cmd: string; args: string[]; input?: string; env?: NodeJS.ProcessEnv }> = [];
    const run: Runner = async (cmd, args, opts = {}) => {
      calls.push({ cmd, args, input: opts.input, env: opts.env });
      const key = cmd.includes("powershell") ? String(opts.env?.DB_CRED_TARGET) : args.slice(-1)[0];
      const script = args[args.length - 1];
      if (args[0] === "store" || script === WINDOWS_WRITE) { store.set(key, opts.input ?? ""); return { code: 0, stdout: "" }; }
      const v = store.get(key);
      return v ? { code: 0, stdout: v + "\n" } : { code: 1, stdout: "" };
    };
    return { run, calls };
  }

  it("Linux: secret-tool, with the value on stdin", async () => {
    const { run, calls } = fakeRunner(new Map());
    const kc = linuxKeychain(run, "/usr/bin/secret-tool");
    expect(await kc.read("ANTHROPIC_API_KEY")).toBeNull();
    expect(await kc.write("ANTHROPIC_API_KEY", "sk-ant-test-123")).toBe(true);
    expect(await kc.read("ANTHROPIC_API_KEY")).toBe("sk-ant-test-123");
    const store = calls.find((c) => c.args[0] === "store")!;
    expect(store.args).toEqual(["store", "--label=Daily brief ANTHROPIC_API_KEY", "service", "app.dailybrief", "account", "ANTHROPIC_API_KEY"]);
    expect(store.args.join(" ")).not.toContain("sk-ant");
    expect(store.input).toBe("sk-ant-test-123");
    expect(await kc.write("ANTHROPIC_API_KEY", "bad value; rm -rf")).toBe(false);
    expect(linuxKeychain(run, null).available()).toBe(false);
  });

  it("Windows: Credential Manager through PowerShell, names in env and the value on stdin", async () => {
    const { run, calls } = fakeRunner(new Map());
    const kc = windowsKeychain(run);
    expect(await kc.write("TOKEN_ENCRYPTION_KEY", "YWJjZGVmZ2hpamtsbW5vcA==")).toBe(true);
    expect(await kc.read("TOKEN_ENCRYPTION_KEY")).toBe("YWJjZGVmZ2hpamtsbW5vcA==");
    const w = calls[0];
    expect(w.cmd).toBe("powershell.exe");
    expect(w.args.slice(-1)[0]).toBe(WINDOWS_WRITE);
    expect(w.env?.DB_CRED_TARGET).toBe("app.dailybrief:TOKEN_ENCRYPTION_KEY");
    expect(w.args.join(" ")).not.toContain("YWJj");
    expect(w.input).toBe("YWJjZGVmZ2hpamtsbW5vcA==");
    expect(calls[1].args.slice(-1)[0]).toBe(WINDOWS_READ);
  });

  it("picks the store for this system", () => {
    expect(osKeychain("darwin")).toBe(macKeychain);
    expect(osKeychain("linux")).not.toBe(macKeychain);
    expect(osKeychain("win32")).not.toBe(macKeychain);
  });
});

describe("notifications per system", () => {
  const capture = () => {
    const calls: Array<{ cmd: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const run = (cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv }) => { calls.push({ cmd, args, env: opts.env }); };
    return { calls, run };
  };

  it("macOS: osascript with escaped strings", () => {
    const { calls, run } = capture();
    osNotify('Your day: "2 owed"', "Send deck", "darwin", run);
    expect(calls[0].cmd).toBe("osascript");
    expect(calls[0].args[1]).toBe('display notification "Send deck" with title "Daily brief" subtitle "Your day: \\"2 owed\\""');
  });

  it("Linux: notify-send with plain arguments", () => {
    const { calls, run } = capture();
    osNotify("Your day", "$(rm -rf ~)", "linux", run);
    expect(calls[0]).toMatchObject({ cmd: "notify-send", args: ["--app-name=Daily brief", "Your day", "$(rm -rf ~)"] });
  });

  it("Windows: a toast whose text comes through env, never the script", () => {
    const { calls, run } = capture();
    osNotify("Your day", "'; Remove-Item C:\\", "win32", run);
    expect(calls[0].cmd).toBe("powershell.exe");
    expect(calls[0].args.slice(-1)[0]).toBe(WINDOWS_TOAST_SCRIPT);
    expect(WINDOWS_TOAST_SCRIPT).not.toContain("Remove-Item");
    expect(calls[0].env).toMatchObject({ DB_NOTIFY_TITLE: "Your day", DB_NOTIFY_BODY: "'; Remove-Item C:\\" });
  });

  it("other systems: nothing, and never throws", () => {
    const { calls, run } = capture();
    osNotify("a", "b", "freebsd", run);
    expect(calls).toHaveLength(0);
    expect(() => osNotify("a", "b", "linux", () => { throw new Error("ENOENT"); })).not.toThrow();
  });
});

describe("log path per system", () => {
  it("matches the desktop app's", () => {
    expect(logPath({}, "darwin", "/Users/m")).toBe("/Users/m/Library/Logs/daily-brief.log");
    expect(logPath({}, "linux", "/home/m")).toBe("/home/m/.local/state/daily-brief/daily-brief.log");
    expect(logPath({ XDG_STATE_HOME: "/x" }, "linux", "/home/m")).toBe("/x/daily-brief/daily-brief.log");
    expect(logPath({ LOCALAPPDATA: "/la" }, "win32", "/h")).toBe(join("/la", "Daily Brief", "daily-brief.log"));
    expect(logPath({ DAILY_BRIEF_LOG: "/tmp/l" }, "linux", "/h")).toBe("/tmp/l");
  });
});

describe("one-time settings messages", () => {
  it("expire after 10 minutes and can be cleared", () => {
    setFlash("widgetToken", "tok", 0);
    expect(getFlash("widgetToken", 1000)).toBe("tok");
    expect(getFlash("widgetToken", 11 * 60_000)).toBeNull();
    setFlash("widgetToken", "tok", 0);
    setFlash("widgetToken", null);
    expect(getFlash("widgetToken", 0)).toBeNull();
  });
});

describe("desktop builds", () => {
  it("build macOS arm64, Windows x64 and Linux AppImage/deb on a tag, from a server staged the same way", async () => {
    const { readFileSync } = await import("node:fs");
    const wf = readFileSync(join(process.cwd(), ".github/workflows/desktop.yml"), "utf8");
    expect(wf).toMatch(/tags: \["v\*"\]/);
    for (const t of ["aarch64-apple-darwin", "x86_64-pc-windows-msvc", "x86_64-unknown-linux-gnu", "appimage,deb", "node scripts/stage-server.mjs"]) expect(wf).toContain(t);
    const conf = JSON.parse(readFileSync(join(process.cwd(), "src-tauri/tauri.conf.json"), "utf8"));
    expect(conf.bundle.targets).toBe("all");
    expect(conf.bundle.icon).toContain("icons/icon.ico");
    expect(conf.bundle.resources["../build/app-server/"]).toBe("server/");
  });
});
