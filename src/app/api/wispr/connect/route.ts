import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { wisprAuthContext } from "@/server/deps";
import { getSessionUserId } from "@/server/session";
import { PENDING_COOKIE, sealPending, startWisprAuth } from "@/server/wispr/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Starts Wispr Flow OAuth for the signed-in user: discovery + dynamic client registration + PKCE.
export async function GET(req: Request) {
  const userId = getSessionUserId(req);
  if (!userId) return NextResponse.redirect(new URL("/", env.appUrl));
  try {
    const { authorizationUrl, pending } = await startWisprAuth(wisprAuthContext(userId));
    const res = NextResponse.redirect(authorizationUrl);
    res.cookies.set(PENDING_COOKIE, sealPending(pending), {
      httpOnly: true,
      secure: env.appUrl.startsWith("https://"),
      sameSite: "lax", // must survive the top-level redirect back from Wispr Flow
      path: "/api/wispr",
      maxAge: 600,
    });
    return res;
  } catch (e) {
    console.error("[wispr/connect]", e instanceof Error ? e.message : e);
    return NextResponse.redirect(new URL("/setup?error=wispr", env.appUrl));
  }
}
