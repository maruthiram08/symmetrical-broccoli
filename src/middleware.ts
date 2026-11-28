import { NextResponse, type NextRequest } from "next/server";
import { isPublicPath, SESSION_COOKIE, verifySession } from "@/server/hosted/session";

// Hosted mode only: every page and API needs a signed-in session, except sign-in itself, the
// cron routes (they check CRON_SECRET) and the billing webhook (it checks Razorpay's signature).
// Local mode passes everything through untouched.
export async function middleware(req: NextRequest) {
  if (process.env.DAILY_BRIEF_MODE !== "hosted") return NextResponse.next();
  const path = req.nextUrl.pathname;
  if (isPublicPath(path)) return NextResponse.next();
  const uid = await verifySession(req.cookies.get(SESSION_COOKIE)?.value, process.env.SESSION_SECRET ?? "");
  if (uid) return NextResponse.next();
  if (path.startsWith("/api/")) return NextResponse.json({ error: "sign_in_required" }, { status: 401 });
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = path === "/" ? "" : `?next=${encodeURIComponent(path + req.nextUrl.search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
