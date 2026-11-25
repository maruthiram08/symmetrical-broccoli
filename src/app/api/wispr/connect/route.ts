import { NextResponse } from "next/server";
import { me, wisprAuthContext } from "@/server/local/app";
import { appUrl } from "@/server/local/paths";
import { PENDING_COOKIE, sealPending, startWisprAuth } from "@/server/wispr/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Starts Wispr Flow OAuth: discovery + dynamic client registration + PKCE.
export async function GET() {
  const user = await me();
  if (!user) return NextResponse.redirect(new URL("/welcome", appUrl()));
  try {
    const { authorizationUrl, pending } = await startWisprAuth(wisprAuthContext(user.id));
    const res = NextResponse.redirect(authorizationUrl);
    res.cookies.set(PENDING_COOKIE, sealPending(pending), { httpOnly: true, sameSite: "lax", path: "/api/wispr", maxAge: 600 });
    return res;
  } catch (e) {
    console.error("[wispr/connect]", e instanceof Error ? e.message : e);
    return NextResponse.redirect(new URL("/setup?error=wispr", appUrl()));
  }
}
