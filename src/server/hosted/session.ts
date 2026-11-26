// The hosted sign-in cookie: "<userId>.<expiresAtSec>.<HMAC-SHA256>", signed with SESSION_SECRET.
// Web Crypto only, so the same code runs in middleware (edge) and in server code (Node).
export const SESSION_COOKIE = "db_session";
export const SESSION_TTL_SEC = 60 * 60 * 24 * 30;

const enc = new TextEncoder();

function b64url(bytes: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function mac(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(`session:${payload}`)));
}

function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function signSession(userId: string, secret: string, nowMs = Date.now(), ttlSec = SESSION_TTL_SEC): Promise<string> {
  if (secret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
  const payload = `${userId}.${Math.floor(nowMs / 1000) + ttlSec}`;
  return `${payload}.${await mac(payload, secret)}`;
}

/** The user id in a valid, unexpired cookie, else null. */
export async function verifySession(value: string | undefined | null, secret: string, nowMs = Date.now()): Promise<string | null> {
  if (!value || secret.length < 32) return null;
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [userId, exp, sig] = parts;
  if (!/^[0-9a-f-]{36}$/i.test(userId) || !/^\d+$/.test(exp)) return null;
  if (Number(exp) * 1000 < nowMs) return null;
  return same(sig, await mac(`${userId}.${exp}`, secret)) ? userId : null;
}

/** Pages and APIs anyone may open in hosted mode; everything else needs a session. */
export function isPublicPath(path: string): boolean {
  return (
    path === "/login" ||
    path.startsWith("/auth/") ||
    path.startsWith("/api/cron/") ||
    path === "/api/billing/webhook" ||
    path === "/api/health" ||
    path.startsWith("/_next/") ||
    path === "/favicon.ico"
  );
}
