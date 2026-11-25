import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decrypt, encrypt } from "./crypto";

const key = randomBytes(32).toString("base64");

describe("crypto", () => {
  it("round-trips", () => {
    const secret = "eyJhbGciOi.access-token.with-üñíçødé";
    const sealed = encrypt(secret, key);
    expect(sealed).not.toContain(secret);
    expect(decrypt(sealed, key)).toBe(secret);
  });
  it("uses a fresh IV each time", () => {
    expect(encrypt("x", key)).not.toBe(encrypt("x", key));
  });
  it("rejects tampering and the wrong key", () => {
    const sealed = encrypt("token", key);
    const body = Buffer.from(sealed.split(".")[1], "base64url");
    body[body.length - 1] ^= 1;
    expect(() => decrypt(`v1.${body.toString("base64url")}`, key)).toThrow();
    expect(() => decrypt(sealed, randomBytes(32).toString("base64"))).toThrow();
  });
  it("requires a 32-byte key", () => {
    expect(() => encrypt("x", randomBytes(16).toString("base64"))).toThrow(/32 bytes/);
  });
});
