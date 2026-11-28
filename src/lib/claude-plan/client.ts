// "Your Claude plan": run AI through the official Claude Code CLI on this Mac, signed in with the
// user's own Claude subscription, so there is no API key and no per-call charge to us or them.
//
// claudePlanClient() looks like the Anthropic SDK client to the rest of the app (messages.create and
// messages.stream), so extraction, Ask, nudges and the rest work unchanged:
// - A request with a tool becomes `claude -p --json-schema <tool schema>`; the CLI's
//   structured_output comes back as that tool's tool_use block.
// - A request without tools comes back as one text block. stream() yields it as a single delta.
// The child runs with no tools, no MCP servers, no settings and no saved session, and with
// ANTHROPIC_API_KEY removed from its environment, so it always uses the plan login.
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";

export type Env = Record<string, string | undefined>;
export const CLAUDE_PLAN_TIMEOUT_MS = 10 * 60_000;

export type SpawnLike = (cmd: string, args: string[], opts: { env: Env }) => {
  stdin: { end(data: string): void } | null;
  stdout: { on(ev: "data", f: (b: Buffer) => void): void } | null;
  stderr: { on(ev: "data", f: (b: Buffer) => void): void } | null;
  on(ev: "close", f: (code: number | null) => void): void;
  on(ev: "error", f: (e: Error) => void): void;
  kill(sig?: string): void;
};

export interface ClaudePlanDeps {
  /** Path to the claude binary; found with findClaudeBinary() when left out. */
  bin?: string;
  spawn?: SpawnLike;
  timeoutMs?: number;
  /** Wait after SIGTERM before SIGKILL. */
  killGraceMs?: number;
  env?: Env;
}

/** Where installers put `claude`. The app is started from Finder, so PATH is short there. */
export function claudeCandidates(env: Env = process.env, home = homedir()): string[] {
  const fromPath = (env.PATH ?? "").split(":").filter(Boolean).map((d) => join(d, "claude"));
  return [
    env.CLAUDE_CODE_BIN ?? "",
    join(home, ".local/bin/claude"),
    join(home, ".claude/local/claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    ...fromPath,
  ].filter(Boolean);
}

export function findClaudeBinary(env: Env = process.env, exists: (p: string) => boolean = existsSync): string | null {
  return claudeCandidates(env).find((p) => exists(p)) ?? null;
}

/** An error shaped like the SDK's, so classifyAnthropicError and the retries treat it the same. */
export class ClaudePlanError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
    this.name = "ClaudePlanError";
  }
}

type Params = Anthropic.MessageCreateParamsNonStreaming;

const textOf = (c: Params["messages"][number]["content"]): string =>
  typeof c === "string" ? c : c.map((b) => ("text" in b && typeof b.text === "string" ? b.text : "")).join("\n");

const systemOf = (s: Params["system"]): string =>
  !s ? "" : typeof s === "string" ? s : s.map((b) => b.text).join("\n");

/** The CLI takes one prompt: earlier turns are written out as a transcript before the last one. */
export function promptOf(messages: Params["messages"]): string {
  if (messages.length === 1) return textOf(messages[0].content);
  return messages.map((m) => `${m.role === "user" ? "User" : "Assistant"}:\n${textOf(m.content)}`).join("\n\n");
}

/** CLI model aliases. A full id (claude-sonnet-5-5) is passed as is. */
/** The app passes qualified names ("claude-plan:sonnet"); the CLI wants the bare alias. */
export function cliModel(model: string): string {
  return model.trim().replace(/^claude-plan:/, "").trim() || "sonnet";
}

export function buildArgs(body: Params): { args: string[]; tool: Anthropic.Tool | null } {
  const tool = (body.tools ?? []).find((t): t is Anthropic.Tool => "input_schema" in t) ?? null;
  const system = systemOf(body.system);
  const args = [
    "-p",
    "--output-format", "json",
    "--model", cliModel(body.model),
    "--tools", "",
    "--strict-mcp-config",
    "--setting-sources", "",
    "--no-session-persistence",
  ];
  if (system) args.push("--system-prompt", system);
  if (tool) args.push("--json-schema", JSON.stringify(tool.input_schema));
  return { args, tool };
}

interface CliResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  api_error_status?: number | null;
  usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
}

function errorFrom(out: string, err: string, code: number | null, r: CliResult | null): ClaudePlanError {
  const text = `${r?.result ?? ""} ${err} ${out}`.slice(0, 2000);
  if (/not logged in|please run \/login|invalid api key|oauth|authentication/i.test(text))
    return new ClaudePlanError("Claude Code isn't signed in. Open Terminal, run claude, and sign in with your Claude plan.", 401);
  if (/usage limit|rate limit|limit reached|resets? at/i.test(text))
    return new ClaudePlanError("Your Claude plan's usage limit is reached for now. It will pick up again after it resets.", 429);
  if (r?.api_error_status) return new ClaudePlanError(`Claude Code: API error ${r.api_error_status}.`, r.api_error_status);
  return new ClaudePlanError(`Claude Code exited with code ${code ?? "?"}.`, code === null ? null : 500);
}

const KILL_GRACE_MS = 3000;

/** Variables that make a child `claude` think it is nested inside another Claude Code session,
 *  or point it at a different endpoint or key. Launching the app from a Claude Code shell
 *  leaks these in, and the child then hangs instead of using the plan login. */
const DROP_KEYS = new Set(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDECODE", "AI_AGENT"]);
const DROP_PREFIXES = ["CLAUDE_CODE_", "CLAUDE_AGENT_SDK_"];
const KEEP = new Set(["CLAUDE_CODE_BIN"]);

export function cleanChildEnv(src: Env): Env {
  const env: Env = {};
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined) continue;
    if (!KEEP.has(k) && (DROP_KEYS.has(k) || DROP_PREFIXES.some((p) => k.startsWith(p)))) continue;
    env[k] = v;
  }
  return env;
}

/** Runs one request through the CLI. Throws ClaudePlanError. */
export async function runClaudePlan(body: Params, deps: ClaudePlanDeps = {}, signal?: AbortSignal): Promise<Anthropic.Message> {
  const bin = deps.bin ?? findClaudeBinary(deps.env);
  if (!bin) throw new ClaudePlanError("Claude Code isn't installed on this Mac. Install it from claude.com/claude-code, then sign in.", 401);
  const { args, tool } = buildArgs(body);
  const env = cleanChildEnv(deps.env ?? process.env);
  const doSpawn = deps.spawn ?? (nodeSpawn as unknown as SpawnLike);

  const { out, err, code } = await new Promise<{ out: string; err: string; code: number | null }>((resolve, reject) => {
    let child: ReturnType<SpawnLike>;
    try { child = doSpawn(bin, args, { env }); } catch (e) { reject(new ClaudePlanError(`Couldn't start Claude Code: ${(e as Error).message}`, null)); return; }
    let out = "", err = "", done = false;
    const finish = (f: () => void) => { if (!done) { done = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort); f(); } };
    let exited = false;
    const stop = () => {
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      const t = setTimeout(() => { if (!exited) { try { child.kill("SIGKILL"); } catch { /* already gone */ } } }, deps.killGraceMs ?? KILL_GRACE_MS);
      (t as { unref?: () => void }).unref?.();
    };
    const onAbort = () => { stop(); finish(() => reject(Object.assign(new Error("Aborted"), { name: "AbortError" }))); };
    const timer = setTimeout(() => { stop(); finish(() => reject(Object.assign(new ClaudePlanError("Claude Code timed out.", 408), { name: "TimeoutError" }))); }, deps.timeoutMs ?? CLAUDE_PLAN_TIMEOUT_MS);
    signal?.addEventListener("abort", onAbort);
    child.stdout?.on("data", (b) => { out += b.toString(); });
    child.stderr?.on("data", (b) => { err += b.toString(); });
    child.on("error", (e) => finish(() => reject(new ClaudePlanError(`Couldn't start Claude Code: ${e.message}`, null))));
    child.on("close", (code) => { exited = true; finish(() => resolve({ out, err, code })); });
    child.stdin?.end(promptOf(body.messages));
  });

  let r: CliResult | null = null;
  try { r = JSON.parse(out.trim().split("\n").filter(Boolean).pop() ?? "") as CliResult; } catch { r = null; }
  if (!r || r.is_error || r.subtype !== "success" || code !== 0) throw errorFrom(out, err, code, r);

  const usage = {
    input_tokens: r.usage?.input_tokens ?? 0,
    output_tokens: r.usage?.output_tokens ?? 0,
    cache_creation_input_tokens: r.usage?.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: r.usage?.cache_read_input_tokens ?? 0,
  };
  let content: Anthropic.ContentBlock[];
  if (tool) {
    let input = r.structured_output;
    if (input === undefined) { try { input = JSON.parse(r.result ?? ""); } catch { input = undefined; } }
    content = input === undefined ? [{ type: "text", text: r.result ?? "", citations: null }] as Anthropic.ContentBlock[]
      : [{ type: "tool_use", id: "toolu_plan", name: tool.name, input }] as Anthropic.ContentBlock[];
  } else {
    content = [{ type: "text", text: r.result ?? "", citations: null }] as Anthropic.ContentBlock[];
  }
  return {
    id: "msg_plan",
    type: "message",
    role: "assistant",
    model: body.model,
    content,
    stop_reason: tool && content[0].type === "tool_use" ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage,
  } as unknown as Anthropic.Message;
}

type StreamEvent = { type: "content_block_delta"; index: number; delta: { type: "text_delta"; text: string } };

/** The Anthropic-like client. Pass it wherever the app takes an Anthropic client. */
export function claudePlanClient(deps: ClaudePlanDeps = {}) {
  return {
    messages: {
      create(body: Params, opts?: { signal?: AbortSignal }): Promise<Anthropic.Message> {
        return runClaudePlan(body, deps, opts?.signal);
      },
      stream(body: Params, opts?: { signal?: AbortSignal }) {
        const final = runClaudePlan(body, deps, opts?.signal);
        final.catch(() => {}); // surfaced through the iterator / finalMessage
        return {
          async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent> {
            const m = await final;
            const text = m.content.map((b) => (b.type === "text" ? b.text : "")).join("");
            if (text) yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } };
          },
          finalMessage: () => final,
        };
      },
    },
  };
}

/** Settings' "Test": is Claude Code installed and signed in? Never throws. Uses a few tokens of the plan. */
export async function checkClaudePlan(deps: ClaudePlanDeps = {}): Promise<{ ok: boolean; message: string }> {
  try {
    const m = await runClaudePlan({ model: "haiku", max_tokens: 16, messages: [{ role: "user", content: "Reply with the word ok." }] }, { timeoutMs: 60_000, ...deps });
    const t = m.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
    return { ok: true, message: `Claude Code is signed in and answering${t ? ` ("${t.slice(0, 20)}")` : ""}.` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Claude Code didn't answer." };
  }
}
