import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { buildArgs, claudePlanClient, cleanChildEnv, cliModel, type Env, findClaudeBinary, runClaudePlan, type SpawnLike } from "./client";
import { classifyAnthropicError } from "../extract/errors";
import { extractMeeting } from "../extract/extract";
import { qualifiedModel } from "../ai/providers";

function fakeSpawn(stdout: string, code = 0, seen: { args?: string[]; env?: Env; stdin?: string } = {}): SpawnLike {
  return ((_cmd: string, args: string[], opts: { env: Env }) => {
    seen.args = args; seen.env = opts.env;
    const c = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; stdin: { end(d: string): void }; kill(): void };
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => {};
    c.stdin = { end: (d: string) => { seen.stdin = d; setTimeout(() => { c.stdout.emit("data", Buffer.from(stdout)); c.emit("close", code); }, 0); } };
    return c;
  }) as unknown as SpawnLike;
}

const ok = (extra: object) => JSON.stringify({ type: "result", subtype: "success", is_error: false, usage: { input_tokens: 10, output_tokens: 5 }, ...extra });
const tool = { name: "record", description: "x", input_schema: { type: "object" as const, properties: { a: { type: "string" } } } };

describe("claude plan client", () => {
  it("turns a tool into --json-schema and structured_output into a tool_use block", async () => {
    const seen: { args?: string[]; env?: Env; stdin?: string } = {};
    const m = await runClaudePlan(
      { model: "claude-sonnet-5-5", max_tokens: 100, system: "SYS", tools: [tool], messages: [{ role: "user", content: "hello" }] },
      { bin: "/x/claude", spawn: fakeSpawn(ok({ result: "{}", structured_output: { a: "b" } }), 0, seen), env: { ANTHROPIC_API_KEY: "sk-secret", HOME: "/h" } },
    );
    expect(m.content[0]).toMatchObject({ type: "tool_use", name: "record", input: { a: "b" } });
    expect(m.stop_reason).toBe("tool_use");
    expect(m.usage.input_tokens).toBe(10);
    expect(seen.args).toContain("--json-schema");
    expect(seen.args![seen.args!.indexOf("--system-prompt") + 1]).toBe("SYS");
    expect(seen.args![seen.args!.indexOf("--tools") + 1]).toBe("");
    expect(seen.env!.ANTHROPIC_API_KEY).toBeUndefined();
    expect(seen.env!.HOME).toBe("/h");
    expect(seen.stdin).toBe("hello");
  });

  it("returns text when there is no tool, and streams it", async () => {
    const c = claudePlanClient({ bin: "/x/claude", spawn: fakeSpawn(ok({ result: "The answer [1]" })) });
    const s = c.messages.stream({ model: "sonnet", max_tokens: 10, messages: [{ role: "user", content: "q" }] });
    const parts: string[] = [];
    for await (const ev of s) parts.push(ev.delta.text);
    expect(parts.join("")).toBe("The answer [1]");
    expect((await s.finalMessage()).stop_reason).toBe("end_turn");
  });

  it("maps sign-in and usage-limit failures to auth and transient", async () => {
    const notIn = runClaudePlan({ model: "s", max_tokens: 1, messages: [{ role: "user", content: "q" }] },
      { bin: "/x/claude", spawn: fakeSpawn(JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" }), 1) });
    await expect(notIn).rejects.toMatchObject({ status: 401 });
    expect(classifyAnthropicError(await notIn.catch((e) => e))).toBe("auth");
    const limit = await runClaudePlan({ model: "s", max_tokens: 1, messages: [{ role: "user", content: "q" }] },
      { bin: "/x/claude", spawn: fakeSpawn(JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Claude usage limit reached. Resets at 9pm" }), 1) }).catch((e) => e);
    expect(classifyAnthropicError(limit)).toBe("transient");
  });

  it("says when Claude Code isn't installed", async () => {
    await expect(runClaudePlan({ model: "s", max_tokens: 1, messages: [{ role: "user", content: "q" }] }, { env: { PATH: "" }, bin: undefined, spawn: fakeSpawn("") }))
      .rejects.toThrow(/isn't installed|Couldn't start/);
  });

  it("finds claude in the usual install places", () => {
    expect(findClaudeBinary({ PATH: "/usr/bin" }, (p) => p === "/opt/homebrew/bin/claude")).toBe("/opt/homebrew/bin/claude");
    expect(findClaudeBinary({ PATH: "", CLAUDE_CODE_BIN: "/custom/claude" }, (p) => p === "/custom/claude")).toBe("/custom/claude");
    expect(buildArgs({ model: "", max_tokens: 1, messages: [{ role: "user", content: "q" }] }).args).toContain("sonnet");
  });

  it("drops nested-session and endpoint variables from the child env", () => {
    const e = cleanChildEnv({ HOME: "/h", PATH: "/bin", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_BIN: "/c", AI_AGENT: "x",
      ANTHROPIC_BASE_URL: "http://proxy", ANTHROPIC_API_KEY: "sk", CLAUDE_AGENT_SDK_VERSION: "1", CLAUDE_CONFIG_DIR: "/cfg" });
    expect(e).toEqual({ HOME: "/h", PATH: "/bin", CLAUDE_CODE_BIN: "/c", CLAUDE_CONFIG_DIR: "/cfg" });
  });

  it("sends SIGKILL when the child ignores SIGTERM after a timeout", async () => {
    const sigs: string[] = [];
    const spawn = (() => {
      const c = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; stdin: { end(d: string): void }; kill(s?: string): void };
      c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = { end: () => {} };
      c.kill = (s?: string) => { sigs.push(s ?? "SIGTERM"); };
      return c;
    }) as unknown as SpawnLike;
    const e = await runClaudePlan({ model: "s", max_tokens: 1, messages: [{ role: "user", content: "q" }] },
      { bin: "/x/claude", spawn, timeoutMs: 5, killGraceMs: 5 }).catch((x) => x);
    expect(e.name).toBe("TimeoutError");
    await new Promise((r) => setTimeout(r, 30));
    expect(sigs).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("doesn't SIGKILL a child that exits after SIGTERM", async () => {
    const sigs: string[] = [];
    const spawn = (() => {
      const c = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; stdin: { end(d: string): void }; kill(s?: string): void };
      c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = { end: () => {} };
      c.kill = (s?: string) => { sigs.push(s ?? "SIGTERM"); setTimeout(() => c.emit("close", null), 0); };
      return c;
    }) as unknown as SpawnLike;
    const ac = new AbortController();
    const p = runClaudePlan({ model: "s", max_tokens: 1, messages: [{ role: "user", content: "q" }] },
      { bin: "/x/claude", spawn, killGraceMs: 10 }, ac.signal).catch((x) => x);
    ac.abort();
    expect((await p).name).toBe("AbortError");
    await new Promise((r) => setTimeout(r, 40));
    expect(sigs).toEqual(["SIGTERM"]);
  });

  it("strips the claude-plan: prefix before passing --model", () => {
    expect(cliModel("claude-plan:sonnet")).toBe("sonnet");
    expect(cliModel("claude-plan:opus")).toBe("opus");
    expect(cliModel("haiku")).toBe("haiku");
    expect(cliModel("claude-plan:")).toBe("sonnet");
  });

  it("runs a real extraction through the plan client with the qualified model name", async () => {
    const seen: { args?: string[]; env?: Env; stdin?: string } = {};
    const client = claudePlanClient({ bin: "/x/claude", spawn: fakeSpawn(ok({ result: "{}", structured_output: { newItems: [], closes: [] } }), 0, seen) });
    const r = await extractMeeting(
      { transcript: "Maruthi: I'll send it.", user: { name: "Maruthi", aliases: [], timeZone: "Asia/Kolkata" },
        meeting: { title: "T", startedAt: "2026-11-25T08:00:00.000Z", participants: [] }, openItems: [] },
      { client, model: qualifiedModel("claude-plan", "sonnet"), retry: { sleep: async () => {} } },
    );
    expect(seen.args![seen.args!.indexOf("--model") + 1]).toBe("sonnet");
    expect(seen.args).toContain("--json-schema");
    expect(r.newItems).toEqual([]);
  });
});
