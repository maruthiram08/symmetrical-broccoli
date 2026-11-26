// Email magic-link sign-in with Supabase Auth, through its REST API (no SDK).
// PKCE: we keep the code verifier in a short-lived httpOnly cookie between sending the link and
// the callback, so the link has to be opened in the same browser. The callback also accepts
// ?token_hash=&type= for an email template that links with {{ .TokenHash }} (any browser).
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { HostedConfig } from "./config";

export const PKCE_COOKIE = "db_pkce";
export const REF_COOKIE = "db_ref";
export const NEXT_COOKIE = "db_next";

type Fetch = typeof fetch;
type AuthCfg = Pick<HostedConfig, "supabaseUrl" | "supabaseAnonKey" | "appUrl" | "allowedEmails">;

const emailSchema = z.string().trim().toLowerCase().email().max(254);

export type SendResult = { ok: true; verifier: string } | { ok: false; error: "invalid_email" | "not_invited" | "send_failed" };

const b64url = (b: Buffer) => b.toString("base64url");
export const pkceChallenge = (verifier: string) => b64url(createHash("sha256").update(verifier).digest());

export function normalizeEmail(email: string): string | null {
  const p = emailSchema.safeParse(email);
  return p.success ? p.data : null;
}

/** Ask Supabase to email a sign-in link. Returns the PKCE verifier for the caller to keep in a cookie. */
export async function sendMagicLink(rawEmail: string, cfg: AuthCfg, f: Fetch = fetch): Promise<SendResult> {
  const email = normalizeEmail(rawEmail);
  if (!email) return { ok: false, error: "invalid_email" };
  if (cfg.allowedEmails.length && !cfg.allowedEmails.includes(email)) return { ok: false, error: "not_invited" };
  const verifier = b64url(randomBytes(48));
  const redirect = `${cfg.appUrl}/auth/callback`;
  try {
    const res = await f(`${cfg.supabaseUrl}/auth/v1/otp?redirect_to=${encodeURIComponent(redirect)}`, {
      method: "POST",
      headers: { apikey: cfg.supabaseAnonKey, authorization: `Bearer ${cfg.supabaseAnonKey}`, "content-type": "application/json" },
      body: JSON.stringify({ email, create_user: true, code_challenge: pkceChallenge(verifier), code_challenge_method: "s256" }),
    });
    if (!res.ok) {
      console.error(`[auth] sending the sign-in link failed: HTTP ${res.status}`);
      return { ok: false, error: "send_failed" };
    }
  } catch (e) {
    console.error(`[auth] sending the sign-in link failed: ${e instanceof Error ? e.name : "Error"}`);
    return { ok: false, error: "send_failed" };
  }
  return { ok: true, verifier };
}

export interface AuthUser { id: string; email: string }

const OTP_TYPES = ["email", "magiclink", "signup", "invite", "recovery", "email_change"] as const;

/**
 * Finish sign-in from the callback URL. Returns the Supabase Auth user, or null when the link is
 * invalid, expired, or for an email that isn't allowed.
 */
export async function completeSignIn(
  params: { code?: string | null; tokenHash?: string | null; type?: string | null; verifier?: string | null },
  cfg: AuthCfg,
  f: Fetch = fetch,
): Promise<AuthUser | null> {
  const headers = { apikey: cfg.supabaseAnonKey, authorization: `Bearer ${cfg.supabaseAnonKey}`, "content-type": "application/json" };
  let res: Response;
  try {
    if (params.code && params.verifier) {
      res = await f(`${cfg.supabaseUrl}/auth/v1/token?grant_type=pkce`, {
        method: "POST", headers, body: JSON.stringify({ auth_code: params.code, code_verifier: params.verifier }),
      });
    } else if (params.tokenHash) {
      const type = OTP_TYPES.includes(params.type as (typeof OTP_TYPES)[number]) ? params.type : "email";
      res = await f(`${cfg.supabaseUrl}/auth/v1/verify`, { method: "POST", headers, body: JSON.stringify({ type, token_hash: params.tokenHash }) });
    } else {
      return null;
    }
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { user?: { id?: string; email?: string } } | null;
  const id = body?.user?.id, email = body?.user?.email ? normalizeEmail(body.user.email) : null;
  if (!id || !email) return null;
  if (cfg.allowedEmails.length && !cfg.allowedEmails.includes(email)) return null;
  return { id, email };
}

/** Only same-site paths survive the round trip through the email (no open redirects). */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/";
  return next.slice(0, 500);
}
