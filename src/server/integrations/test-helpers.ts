// Test doubles for the integrations. Not imported by production code. No test reaches the network:
// every HTTP call goes to `mockFetch`, which records it and answers from the handlers given.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "@/server/store";
import { IntegrationsStore } from "./config";
import type { Fetch } from "./http";
import type { IntegrationSecret, Vault } from "./vault";

export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export type Handler = (call: Call) => { status?: number; json?: unknown } | undefined;

/** A fetch that never leaves the process. Unknown URLs answer 599 so a test notices. */
export function mockFetch(...handlers: Handler[]): Fetch & { calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
    let body: unknown = init.body;
    if (typeof init.body === "string") {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    const call: Call = { url, method: init.method ?? "GET", headers, body };
    calls.push(call);
    for (const h of handlers) {
      const r = h(call);
      if (r) return new Response(r.json === undefined ? null : JSON.stringify(r.json), { status: r.status ?? 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ message: "no mock" }), { status: 599 });
  }) as Fetch & { calls: Call[] };
  f.calls = calls;
  return f;
}

export function memVault(init: Partial<Record<IntegrationSecret, string>> = {}): Vault {
  const m = new Map(Object.entries(init) as Array<[IntegrationSecret, string]>);
  return {
    where: "file",
    async get(n) { return m.get(n) ?? null; },
    async set(n, v) { m.set(n, v); return true; },
    async remove(n) { m.delete(n); },
  };
}

export function tmpIntegrations(): IntegrationsStore {
  return new IntegrationsStore(join(mkdtempSync(join(tmpdir(), "db-int-")), "integrations.json"));
}

export const NOW = new Date("2026-11-26T10:00:00.000Z");

/** A store with you (Maruthi), one meeting and three items: you owe, waiting on Nitin, a decision. */
export async function seeded() {
  const store = new MemoryStore();
  const user = store.addUser({ email: "you@this-mac", name: "Maruthi R", aliases: ["Maru"], timeZone: "Asia/Kolkata" });
  const { meeting } = await store.upsertMeeting({ userId: user.id, providerMeetingId: "w1", title: "Banner sync", startedAt: "2026-11-24T08:30:00.000Z", participants: ["Nitin Kumar"] });
  await store.commitExtraction({
    meetingId: meeting.id, userId: user.id, at: "2026-11-24T09:00:00.000Z", closes: [],
    newItems: [
      { kind: "owe", text: "Send Nitin the final banner text", person: "Nitin", quote: "I'll send you the final text by Friday", meetingId: meeting.id, dueAt: "2026-11-27T12:30:00.000Z" },
      { kind: "waiting", text: "Nitin to share the API spec", person: "Nitin", quote: "Main spec bhej dunga kal tak", meetingId: meeting.id, dueAt: null },
      { kind: "decision", text: "Launch the dividend banner on Monday", person: null, quote: "Let's go Monday", meetingId: meeting.id, dueAt: null },
    ],
  });
  const items = await store.listItems(user.id);
  const owe = items.find((i) => i.kind === "owe")!;
  const waiting = items.find((i) => i.kind === "waiting")!;
  const decision = items.find((i) => i.kind === "decision")!;
  return { store, user, meeting, owe, waiting, decision };
}
