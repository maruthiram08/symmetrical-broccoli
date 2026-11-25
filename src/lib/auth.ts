// Magic-link sign-in with Supabase Auth (PKCE). The PKCE verifier lives in a short-lived httpOnly
// cookie between sending the link and the callback, so the link must be opened in the same browser.
// The callback also accepts ?token_hash=&type= for an email template that uses {{ .TokenHash }}.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { z } from "zod";
import { env } from "@/lib/env";

const STORAGE_KEY = "db-auth";
const VERIFIER_KEY = `${STORAGE_KEY}-code-verifier`;
const PKCE_COOKIE = "db_pkce";

/** Service-role client for server code. Bypasses RLS: only use with ids from a verified session or token. */
export function serviceClient(): SupabaseClient {
  return createClient(env.supabaseUrl, env.supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/** An auth client whose storage is a plain Map, so we can move the PKCE verifier into a cookie. */
function authClient(store: Map<string, string>): SupabaseClient {
  return createClient(env.supabaseUrl, env.supabaseServiceKey, {
    auth: {
      flowType: "pkce",
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey: STORAGE_KEY,
      storage: {
        getItem: (k) => store.get(k) ?? null,
        setItem: (k, v) => void store.set(k, v),
        removeItem: (k) => void store.delete(k),
      },
    },
  });
}

const emailSchema = z.string().trim().toLowerCase().email().max(254);

export type MagicLinkResult = { ok: true } | { ok: false; error: "invalid_email" | "send_failed" };

/** Sends the sign-in email. Call from a server action (it sets the PKCE cookie). */
export async function sendMagicLink(email: string): Promise<MagicLinkResult> {
  const parsed = emailSchema.safeParse(email);
  if (!parsed.success) return { ok: false, error: "invalid_email" };
  const store = new Map<string, string>();
  const { error } = await authClient(store).auth.signInWithOtp({
    email: parsed.data,
    options: { emailRedirectTo: `${env.appUrl.replace(/\/+$/, "")}/auth/callback`, shouldCreateUser: true },
  });
  if (error) {
    console.error("sendMagicLink failed", error.message);
    return { ok: false, error: "send_failed" };
  }
  const verifier = store.get(VERIFIER_KEY);
  if (verifier) {
    (await cookies()).set(PKCE_COOKIE, verifier, {
      httpOnly: true,
      secure: env.appUrl.startsWith("https://"),
      sameSite: "lax",
      path: "/auth",
      maxAge: 60 * 60,
    });
  }
  return { ok: true };
}

const otpTypes = ["email", "magiclink", "signup", "invite", "recovery", "email_change"] as const;
type OtpType = (typeof otpTypes)[number];

/**
 * Finishes sign-in from the callback URL and makes sure a users row exists.
 * Returns our users.id, or null when the link is invalid or expired.
 */
export async function completeSignIn(params: { code?: string | null; tokenHash?: string | null; type?: string | null }): Promise<string | null> {
  const jar = await cookies();
  const store = new Map<string, string>();
  const verifier = jar.get(PKCE_COOKIE)?.value;
  if (verifier) store.set(VERIFIER_KEY, verifier);
  const auth = authClient(store).auth;

  let user: { id: string; email?: string } | null = null;
  if (params.code) {
    const { data, error } = await auth.exchangeCodeForSession(params.code);
    if (error) console.error("exchangeCodeForSession failed", error.message);
    user = data.user;
  } else if (params.tokenHash) {
    const type: OtpType = otpTypes.includes(params.type as OtpType) ? (params.type as OtpType) : "email";
    const { data, error } = await auth.verifyOtp({ token_hash: params.tokenHash, type });
    if (error) console.error("verifyOtp failed", error.message);
    user = data.user;
  }
  jar.delete({ name: PKCE_COOKIE, path: "/auth" });
  if (!user?.email) return null;
  return ensureUserRow(user.id, user.email.toLowerCase());
}

/** Inserts the users row on first sign-in (id = the Supabase Auth user id). Returns the row id. */
async function ensureUserRow(authId: string, email: string): Promise<string> {
  const db = serviceClient();
  const { error: upsertError } = await db.from("users").upsert({ id: authId, email }, { onConflict: "email", ignoreDuplicates: true });
  if (upsertError) throw new Error(`users upsert failed: ${upsertError.message}`);
  const { data, error } = await db.from("users").select("id").eq("email", email).single();
  if (error || !data) throw new Error(`users lookup failed: ${error?.message}`);
  return data.id as string;
}

export interface UserSettings {
  id: string;
  email: string;
  name: string;
  timeZone: string;
  briefTime: string;
}

export async function getUserSettings(uid: string): Promise<UserSettings | null> {
  const { data, error } = await serviceClient().from("users").select("id,email,name,time_zone,brief_time").eq("id", uid).maybeSingle();
  if (error || !data) return null;
  return { id: data.id, email: data.email, name: data.name, timeZone: data.time_zone, briefTime: data.brief_time };
}

export async function updateUserSettings(uid: string, s: { name: string; timeZone: string; briefTime: string }): Promise<void> {
  const { error } = await serviceClient().from("users").update({ name: s.name, time_zone: s.timeZone, brief_time: s.briefTime }).eq("id", uid);
  if (error) throw new Error(`users update failed: ${error.message}`);
}
