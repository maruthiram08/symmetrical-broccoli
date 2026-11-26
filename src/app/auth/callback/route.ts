import { NextResponse, type NextRequest } from "next/server";
import { isHosted } from "@/server/mode";
import { rootStore } from "@/server/hosted/app";
import { completeSignIn, NEXT_COOKIE, PKCE_COOKIE, REF_COOKIE, safeNext } from "@/server/hosted/auth";
import { redeemReferral } from "@/server/hosted/billing";
import { hostedConfig } from "@/server/hosted/config";
import { SESSION_COOKIE, SESSION_TTL_SEC, signSession } from "@/server/hosted/session";
import { acceptInvites } from "@/server/hosted/teams";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NEW_USER_MS = 24 * 60 * 60_000;

// The link in the sign-in email lands here: finish the Supabase sign-in, make sure the user has a
// row, join any team that invited them, apply a friend's referral code, and set our session cookie.
export async function GET(req: NextRequest) {
  const cfg = hostedConfig();
  const to = (path: string) => NextResponse.redirect(new URL(path, cfg.appUrl));
  if (!isHosted()) return to("/");
  const q = req.nextUrl.searchParams;
  const user = await completeSignIn(
    { code: q.get("code"), tokenHash: q.get("token_hash"), type: q.get("type"), verifier: req.cookies.get(PKCE_COOKIE)?.value },
    cfg,
  );
  if (!user) return to("/login?error=link");

  const root = rootStore();
  const row = await root.ensureUser(user.id, user.email);
  if (cfg.teamsEnabled) await acceptInvites(root.db, row.id, row.email).catch(() => 0);
  const ref = req.cookies.get(REF_COOKIE)?.value;
  if (ref && Date.now() - Date.parse(row.createdAt) < NEW_USER_MS) await redeemReferral(root.db, row.id, ref, cfg.billing, new Date()).catch(() => null);

  const res = to(safeNext(req.cookies.get(NEXT_COOKIE)?.value));
  res.cookies.set(SESSION_COOKIE, await signSession(row.id, cfg.sessionSecret), {
    httpOnly: true, secure: cfg.appUrl.startsWith("https://"), sameSite: "lax", path: "/", maxAge: SESSION_TTL_SEC,
  });
  for (const c of [PKCE_COOKIE, NEXT_COOKIE, REF_COOKIE]) res.cookies.set(c, "", { path: "/auth", maxAge: 0 });
  return res;
}
