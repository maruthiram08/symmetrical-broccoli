import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { timeline } from "@/lib/wow/timeline";
import type { Keychain, SecretName } from "@/server/local/keychain";
import { FileStore } from "@/server/local/file-store";
import { IntegrationsStore } from "./config";
import { fileVault, keychainVault, lastFour } from "./vault";
import { NOW } from "./test-helpers";

const dir = () => mkdtempSync(join(tmpdir(), "db-vault-"));

describe("vault", () => {
  it("file fallback: private file, set, get, remove; refuses odd values", async () => {
    const p = join(dir(), "secrets.json");
    const v = fileVault(p);
    expect(await v.get("LINEAR_API_KEY")).toBeNull();
    expect(await v.set("LINEAR_API_KEY", "lin_api_abcdef123")).toBe(true);
    expect(await v.get("LINEAR_API_KEY")).toBe("lin_api_abcdef123");
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(await v.set("NOTION_TOKEN", "has spaces; rm -rf")).toBe(false);
    await v.remove("LINEAR_API_KEY");
    expect(await fileVault(p).get("LINEAR_API_KEY")).toBeNull();
  });

  it("Keychain: reads once, then from memory; a write or remove is seen at once", async () => {
    const m = new Map<SecretName, string>();
    let reads = 0;
    const kc: Keychain = {
      available: () => true,
      read: async (n) => { reads++; return m.get(n) ?? null; },
      write: async (n, val) => { m.set(n, val); return true; },
      remove: async (n) => m.delete(n),
    };
    const v = keychainVault(kc);
    expect(await v.get("JIRA_API_TOKEN")).toBeNull();
    expect(await v.get("JIRA_API_TOKEN")).toBeNull();
    expect(reads).toBe(1);
    await v.set("JIRA_API_TOKEN", "ATATT3xFfGF0abc=ABCD1234");
    expect(await v.get("JIRA_API_TOKEN")).toBe("ATATT3xFfGF0abc=ABCD1234");
    await v.remove("JIRA_API_TOKEN");
    expect(await v.get("JIRA_API_TOKEN")).toBeNull();
    expect(m.has("JIRA_API_TOKEN")).toBe(false);
  });

  it("shows only the last four", () => {
    expect(lastFour("lin_api_abcdef1234")).toBe("••••1234");
    expect(lastFour(null)).toBeNull();
  });
});

describe("integrations.json", () => {
  it("starts with everything off and survives a reload", () => {
    const p = join(dir(), "integrations.json");
    const s = new IntegrationsStore(p);
    const st = s.read();
    expect([st.providers.jira.enabled, st.providers.linear.enabled, st.providers.notion.enabled, st.providers.todoist.enabled, st.webhooks.enabled]).toEqual([false, false, false, false, false]);
    s.update((x) => { x.providers.linear = { enabled: true, teamKey: "ENG", teamId: "t" }; });
    expect(new IntegrationsStore(p).read().providers.linear.teamKey).toBe("ENG");
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });
});

describe("FileStore keeps tickets and close reasons", () => {
  it("writes them to state.json and shows the reason on the timeline", async () => {
    const path = join(dir(), "state.json");
    const a = new FileStore(path);
    const user = a.addUser({ email: "you@this-mac", name: "Maruthi" });
    const item = await a.addManualItem(user.id, { kind: "owe", text: "Book the venue", person: null, dueAt: null }, NOW.toISOString());
    await a.setItemTicket(item.id, { provider: "linear", id: "iss-1", key: "LIN-123", url: "https://linear.app/a/issue/LIN-123", createdAt: NOW.toISOString() });
    expect(await a.closeItemWithReason(item.id, "Closed in Linear", NOW.toISOString())).toBe(true);
    expect(await a.closeItemWithReason(item.id, "Closed in Linear", NOW.toISOString())).toBe(false); // already closed
    const b = new FileStore(path);
    const got = (await b.listItems(user.id))[0];
    expect(got).toMatchObject({ status: "done", closeReason: "Closed in Linear", ticket: { key: "LIN-123" } });
    const ev = timeline(got, [got], [], NOW, ["Maruthi"]).find((e) => e.kind === "marked");
    expect(ev).toMatchObject({ kind: "marked", status: "done", reason: "Closed in Linear" });
  });
});
