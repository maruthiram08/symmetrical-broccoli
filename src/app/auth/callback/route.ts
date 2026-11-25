import { NextResponse, type NextRequest } from "next/server";
import { completeSignIn } from "@/lib/auth";
import { setSessionCookie } from "@/lib/session-cookie";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const base = env.appUrl.replace(/\/+$/, "");
  let uid: string | null = null;
  try {
    uid = await completeSignIn({
      code: url.searchParams.get("code"),
      tokenHash: url.searchParams.get("token_hash"),
      type: url.searchParams.get("type"),
    });
  } catch (e) {
    console.error("sign-in callback failed", e);
  }
  if (!uid) return NextResponse.redirect(`${base}/?error=link`);
  await setSessionCookie(uid);
  return NextResponse.redirect(`${base}/setup`);
}
