import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { buildArgs, claudePlanClient, type Env, findClaudeBinary, runClaudePlan, type SpawnLike } from "./client";
import { classifyAnthropicError } from "../extract/errors";

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
});
