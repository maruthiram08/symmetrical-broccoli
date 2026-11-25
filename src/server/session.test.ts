import { describe, expect, it } from "vitest";
import { getSessionUserId, sessionCookie } from "./session";

const secret = "test-secret";
const uid = "00000000-0000-4000-8000-000000000001";
const req = (cookie?: string) => new Request("https://app.test/api/wispr/connect", { headers: cookie ? { cookie } : {} });

describe("getSessionUserId", () => {
  it("reads a valid signed cookie", () => {
    expect(getSessionUserId(req(`other=1; ${sessionCookie(uid, secret)}`), secret)).toBe(uid);
  });
  it("rejects a missing, unsigned or forged cookie", () => {
    expect(getSessionUserId(req(), secret)).toBeNull();
    expect(getSessionUserId(req(`db_uid=${uid}`), secret)).toBeNull();
    expect(getSessionUserId(req(sessionCookie(uid, "other-secret")), secret)).toBeNull();
  });
});
