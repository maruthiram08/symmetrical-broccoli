import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { MemoryStore } from "@/server/store";
import { connect } from "@/server/testing";
import {
  ensureFreshAccessToken, finishWisprAuth, MAX_REFRESH_FAILURES, MemoryOAuthClientStore, openPending, ReconnectRequiredError, sealPending,
  WisprOAuthProvider, type WisprAuthContext,
} from "./oauth";

const key = randomBytes(32).toString("base64");
const NOW = new Date("2026-11-25T12:00:00Z");

function ctx(): WisprAuthContext & { store: MemoryStore; clients: MemoryOAuthClientStore } {
  const store = new MemoryStore();
  const user = store.addUser({ email: "a@b.c" });
  const clients = new MemoryOAuthClientStore();
  clients.clients.set(user.id, { client_id: "cid" });
  return { userId: user.id, store, clients, appUrl: "https://app.test", serverUrl: "https://mcp.test/mcp", now: () => NOW };
}

describe("ensureFreshAccessToken", () => {
  it("returns a token that is still valid without refreshing", async () => {
    const c = ctx();
    connect(c.store, c.userId, { expiresAt: "2026-11-25T13:00:00.000Z" });
    let called = false;
    expect(await ensureFreshAccessToken(c, { refresh: async () => { called = true; throw new Error(); } })).toBe("at");
    expect(called).toBe(false);
  });

  it("refreshes an expired token and keeps lastSeenAt", async () => {
    const c = ctx();
    connect(c.store, c.userId, { expiresAt: "2026-11-25T11:59:30.000Z", lastSeenAt: "2026-11-24T10:00:00.000Z" });
    const token = await ensureFreshAccessToken(c, { refresh: async ({ refreshToken }) => ({ access_token: `new-${refreshToken}`, token_type: "Bearer", expires_in: 3600 }) });
    expect(token).toBe("new-rt");
    expect(c.store.connections.get(c.userId)).toMatchObject({
      accessToken: "new-rt", refreshToken: "rt", expiresAt: "2026-11-25T13:00:00.000Z", lastSeenAt: "2026-11-24T10:00:00.000Z", status: "active",
    });
  });

  it("marks needs_reconnect when the refresh grant is rejected", async () => {
    const c = ctx();
    connect(c.store, c.userId, { expiresAt: "2026-11-25T11:00:00.000Z" });
    await expect(ensureFreshAccessToken(c, { refresh: async () => { throw new InvalidGrantError("revoked"); } })).rejects.toBeInstanceOf(ReconnectRequiredError);
    expect(c.store.connections.get(c.userId)?.status).toBe("needs_reconnect");
    expect(c.store.events.some((e) => e.type === "job_error")).toBe(true);
  });

  it("leaves the connection active on a transient refresh failure", async () => {
    const c = ctx();
    connect(c.store, c.userId, { expiresAt: "2026-11-25T11:00:00.000Z" });
    await expect(ensureFreshAccessToken(c, { refresh: async () => { throw new TypeError("fetch failed"); } })).rejects.toThrow("fetch failed");
    expect(c.store.connections.get(c.userId)?.status).toBe("active");
  });
});

describe("refresh that keeps failing", () => {
  it("asks to reconnect after a few refreshes Wispr Flow rejects, and then stops trying", async () => {
    const c = ctx();
    connect(c.store, c.userId, { expiresAt: "2026-11-25T11:00:00.000Z" });
    let calls = 0;
    const refresh = async () => { calls++; throw Object.assign(new Error("HTTP 500"), { name: "ServerError" }); };
    for (let i = 1; i < MAX_REFRESH_FAILURES; i++) {
      await expect(ensureFreshAccessToken(c, { refresh })).rejects.toThrow("HTTP 500");
      expect(c.store.connections.get(c.userId)).toMatchObject({ status: "active", refreshFailures: i });
    }
    await expect(ensureFreshAccessToken(c, { refresh })).rejects.toBeInstanceOf(ReconnectRequiredError);
    expect(c.store.connections.get(c.userId)?.status).toBe("needs_reconnect");
    // No more refresh attempts once reconnect is needed.
    await expect(ensureFreshAccessToken(c, { refresh })).rejects.toBeInstanceOf(ReconnectRequiredError);
    expect(calls).toBe(MAX_REFRESH_FAILURES);
    expect(c.store.events.filter((e) => e.type === "job_error")).toHaveLength(1);
  });

  it("being offline never counts against the sign-in, and a good refresh resets the count", async () => {
    const c = ctx();
    connect(c.store, c.userId, { expiresAt: "2026-11-25T11:00:00.000Z", refreshFailures: 2 });
    for (let i = 0; i < 10; i++) {
      await expect(ensureFreshAccessToken(c, { refresh: async () => { throw new TypeError("fetch failed"); } })).rejects.toThrow("fetch failed");
    }
    expect(c.store.connections.get(c.userId)).toMatchObject({ status: "active", refreshFailures: 2 });
    await ensureFreshAccessToken(c, { refresh: async () => ({ access_token: "A2", token_type: "Bearer", expires_in: 3600 }) });
    expect(c.store.connections.get(c.userId)).toMatchObject({ status: "active", refreshFailures: 0, accessToken: "A2" });
  });
});

describe("WisprOAuthProvider", () => {
  it("background: a required redirect marks needs_reconnect instead of redirecting", async () => {
    const c = ctx();
    connect(c.store, c.userId);
    const p = new WisprOAuthProvider(c, "background");
    await expect(p.redirectToAuthorization(new URL("https://auth.test/authorize"))).rejects.toBeInstanceOf(ReconnectRequiredError);
    expect(c.store.connections.get(c.userId)?.status).toBe("needs_reconnect");
  });

  it("interactive: saveTokens creates the connection and stores the registration", async () => {
    const c = ctx();
    c.clients.clients.clear();
    const pending = { userId: c.userId, state: "s", exp: NOW.getTime() + 1000, clientInformation: { client_id: "fresh" } };
    const p = new WisprOAuthProvider(c, "interactive", pending);
    expect(p.redirectUrl).toBe("https://app.test/api/wispr/callback");
    await p.saveTokens({ access_token: "A", refresh_token: "R", token_type: "Bearer", expires_in: 60 });
    expect(c.store.connections.get(c.userId)).toMatchObject({ accessToken: "A", refreshToken: "R", status: "active", lastSeenAt: null });
    expect(await c.clients.getOAuthClient(c.userId)).toEqual({ client_id: "fresh" });
  });
});

describe("pending auth cookie", () => {
  it("round-trips and expires", () => {
    const p = { userId: "u", state: "s", codeVerifier: "v", exp: NOW.getTime() + 60_000 };
    const sealed = sealPending(p, key);
    expect(openPending(sealed, NOW, key)).toEqual(p);
    expect(openPending(sealed, new Date(NOW.getTime() + 120_000), key)).toBeNull();
    expect(openPending(sealed.slice(0, -2) + "xx", NOW, key)).toBeNull();
    expect(openPending(undefined, NOW, key)).toBeNull();
  });

  it("finishWisprAuth rejects a state or user mismatch before any network call", async () => {
    const c = ctx();
    const pending = { userId: c.userId, state: "good", codeVerifier: "v", exp: NOW.getTime() + 60_000 };
    await expect(finishWisprAuth(c, { pending, code: "c", state: "bad" })).rejects.toThrow(/state/);
    await expect(finishWisprAuth({ ...c, userId: "someone-else" }, { pending, code: "c", state: "good" })).rejects.toThrow(/user/);
    await expect(finishWisprAuth(c, { pending: null, code: "c", state: "good" })).rejects.toThrow(/expired/);
  });
});
