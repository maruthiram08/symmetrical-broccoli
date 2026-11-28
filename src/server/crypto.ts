import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "@/lib/env";

// AES-256-GCM for OAuth tokens at rest. Format: "v1.<base64url(iv | tag | ciphertext)>".
const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

function keyFrom(keyB64: string): Buffer {
  const key = Buffer.from(keyB64, "base64");
  if (key.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  return key;
}

export function encrypt(plaintext: string, keyB64: string = env.tokenKey): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(keyB64), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}.${Buffer.concat([iv, tag, ct]).toString("base64url")}`;
}

export function decrypt(sealed: string, keyB64: string = env.tokenKey): string {
  const [version, body] = sealed.split(".");
  if (version !== VERSION || !body) throw new Error("Unrecognised ciphertext format");
  const raw = Buffer.from(body, "base64url");
  if (raw.length < IV_BYTES + TAG_BYTES) throw new Error("Ciphertext too short");
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ct = raw.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", keyFrom(keyB64), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
