// Request-based reader for the signed "db_uid" session cookie.
// The cookie format and signing (HMAC-SHA256 with LINK_SIGNING_SECRET) are owned by
// src/lib/session-cookie.ts; this delegates to it so both always agree.
import { SESSION_COOKIE, signSession, verifySession } from "@/lib/session-cookie";

export { SESSION_COOKIE };

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** The signed-in user's id from the request's db_uid cookie, or null. */
export function getSessionUserId(req: Request, secret?: string): string | null {
  return verifySession(readCookie(req, SESSION_COOKIE), secret);
}

/** Cookie header value for tests and tools. */
export function sessionCookie(userId: string, secret?: string): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(signSession(userId, secret))}`;
}
