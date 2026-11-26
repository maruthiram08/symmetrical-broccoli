import { describe, expect, it } from "vitest";
import { McpWisprClient, parseSummary, type ToolCaller } from "./client";
import { MemoryOAuthClientStore } from "./oauth";
import { MemoryStore } from "@/server/store";
import { connect } from "@/server/testing";

const text = (obj: unknown) => ({ content: [{ type: "text", text: JSON.stringify(obj) }] });

describe("parseSummary", () => {
  it("reads the summary markdown and tolerates its absence", () => {
    expect(parseSummary({ id: "m", summary: "## Next steps\n- Asha: x" })).toBe("## Next steps\n- Asha: x");
    expect(parseSummary({ id: "m" })).toBeNull();
    expect(parseSummary({ id: "m", summary: null })).toBeNull();
    expect(parseSummary({ id: "m", summary: "   " })).toBeNull();
    expect(parseSummary({ id: "m", summary: 42 })).toBeNull();
    expect(parseSummary({ id: "m", summary: { markdown: "# S" } })).toBe("# S");
    expect(parseSummary("nope")).toBeNull();
  });
});

describe("McpWisprClient.getSummary", () => {
  it("calls get_meeting without view_transcript", async () => {
    const store = new MemoryStore();
    const user = store.addUser({ email: "a@b.c" });
    connect(store, user.id);
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const caller: ToolCaller = {
      callTool: async (name, args) => { calls.push({ name, args }); return text({ id: "x", summary: "## Action items\n- Ravi to ship" }); },
      close: async () => {},
    };
    const client = new McpWisprClient(
      { userId: user.id, store, clients: new MemoryOAuthClientStore(), appUrl: "https://app.test", serverUrl: "https://mcp.test/mcp", now: () => new Date("2026-11-25T13:00:00Z") },
      { connect: async () => caller },
    );
    expect(await client.getSummary("x")).toBe("## Action items\n- Ravi to ship");
    expect(calls).toEqual([{ name: "get_meeting", args: { meeting_id: "x", view_content: { char_limit: 1 } } }]);
    expect(calls[0].args).not.toHaveProperty("view_transcript");
  });
});
