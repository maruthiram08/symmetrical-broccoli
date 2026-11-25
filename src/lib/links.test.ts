import { beforeAll, describe, expect, it } from "vitest";
import { accountUrl, actionUrl, LINK_TTL_SECONDS, signToken, verifyToken } from "./links";

const NOW = Date.UTC(2026, 10, 25, 12, 30);
const tokenOf = (url: string) => url.split("/a/")[1];

beforeAll(() => {
  process.env.LINK_SIGNING_SECRET = "test-secret-for-links";
  process.env.APP_URL = "https://brief.example.com/";
});

describe("signed links", () => {
  it("builds {APP_URL}/a/<token> and round-trips an item action", () => {
    const url = actionUrl("user-1", "item-9", "done", NOW);
    expect(url.startsWith("https://brief.example.com/a/")).toBe(true);
    const p = verifyToken(tokenOf(url), NOW);
    expect(p).toEqual({ u: "user-1", i: "item-9", a: "done", exp: Math.floor(NOW / 1000) + LINK_TTL_SECONDS });
  });

  it("round-trips account actions without an item id", () => {
    for (const a of ["download", "delete"] as const) {
      const p = verifyToken(tokenOf(accountUrl("user-1", a, NOW)), NOW);
      expect(p).toMatchObject({ u: "user-1", a });
      expect(p?.i).toBeUndefined();
    }
  });

  it("supports wrong and undo", () => {
    expect(verifyToken(tokenOf(actionUrl("u", "i", "wrong", NOW)), NOW)?.a).toBe("wrong");
    expect(verifyToken(tokenOf(actionUrl("u", "i", "undo", NOW)), NOW)?.a).toBe("undo");
  });

  it("expires after 30 days", () => {
    const t = tokenOf(actionUrl("u", "i", "done", NOW));
    expect(verifyToken(t, NOW + 29 * 86400_000)).not.toBeNull();
    expect(verifyToken(t, NOW + 30 * 86400_000)).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const t = tokenOf(actionUrl("user-1", "item-9", "done", NOW));
    const [, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ u: "user-2", i: "item-9", a: "done", exp: 9999999999 })).toString("base64url");
    expect(verifyToken(`${forged}.${sig}`, NOW)).toBeNull();
  });

  it("rejects a tampered or truncated signature", () => {
    const t = tokenOf(actionUrl("u", "i", "done", NOW));
    const flip = t.slice(0, -1) + (t.endsWith("A") ? "B" : "A");
    expect(verifyToken(flip, NOW)).toBeNull();
    expect(verifyToken(t.slice(0, -4), NOW)).toBeNull();
  });

  it("rejects tokens signed with another secret", () => {
    const t = signToken({ u: "u", i: "i", a: "done", exp: Math.floor(NOW / 1000) + 60 }, "other-secret");
    expect(verifyToken(t, NOW)).toBeNull();
  });

  it("rejects malformed input and invalid payload shapes", () => {
    expect(verifyToken("", NOW)).toBeNull();
    expect(verifyToken("abc", NOW)).toBeNull();
    expect(verifyToken("a.b.c", NOW)).toBeNull();
    expect(verifyToken("not base64!.sig", NOW)).toBeNull();
    const exp = Math.floor(NOW / 1000) + 60;
    // item action without an item id
    expect(verifyToken(signToken({ u: "u", a: "done", exp }), NOW)).toBeNull();
    // account action with an item id
    expect(verifyToken(signToken({ u: "u", i: "x", a: "delete", exp }), NOW)).toBeNull();
    // unknown action
    expect(verifyToken(signToken({ u: "u", a: "pay" as never, exp }), NOW)).toBeNull();
  });
});
