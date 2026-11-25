// The signed "db_uid" cookie: value = <uid>.<base64url HMAC-SHA256("session:" + uid, LINK_SIGNING_SECRET)>.
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { env } from "@/lib/env";

export const SESSION_COOKIE = "db_uid";
const MAX_AGE = 60 * 60 * 24 * 180; // 180 days

function mac(uid: string, secret: string): string {
  return createHmac("sha256", secret).update(`session:${uid}`).digest("base64url");
}

export function signSession(uid: string, secret: string = env.linkSecret): string {
  return `${uid}.${mac(uid, secret)}`;
}

export function verifySession(value: string | undefined | null, secret: string = env.linkSecret): string | null {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const uid = value.slice(0, dot);
  if (!/^[0-9a-f-]{1,64}$/i.test(uid)) return null;
  const given = Buffer.from(value.slice(dot + 1), "base64url");
  const expected = Buffer.from(mac(uid, secret), "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return uid;
}

/** Sets the session cookie. Call from a route handler or server action. */
export async function setSessionCookie(uid: string): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, signSession(uid), {
    httpOnly: true,
    secure: env.appUrl.startsWith("https://"),
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE,
  });
}

/** Returns the signed-in user id, or null. */
export async function readSession(): Promise<string | null> {
  return verifySession((await cookies()).get(SESSION_COOKIE)?.value);
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}
