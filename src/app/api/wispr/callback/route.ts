import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { buildDeps, me, wisprAuthContext } from "@/server/local/app";
import { appUrl } from "@/server/local/paths";
import { backfillUser } from "@/server/jobs/backfill";
import { logJobError } from "@/server/jobs/types";
import { finishWisprAuth, openPending, PENDING_COOKIE } from "@/server/wispr/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const WAIT_MS = 45_000;

function done(path: string) {
  const res = NextResponse.redirect(new URL(path, appUrl()));
  res.cookies.set(PENDING_COOKIE, "", { path: "/api/wispr", maxAge: 0 });
  return res;
}

// Finishes OAuth, saves the connection, reads the last 7 days, then shows the Connected page.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const user = await me();
  if (url.searchParams.get("error")) return done("/setup?error=wispr");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state || !user) return done("/setup?error=wispr");

  try {
    const pending = openPending((await cookies()).get(PENDING_COOKIE)?.value, new Date());
    await finishWisprAuth(wisprAuthContext(user.id), { pending, code, state });
  } catch (e) {
    console.error("[wispr/callback]", e instanceof Error ? e.message : e);
    return done("/setup?error=wispr");
  }

  // The app keeps running, so a slow backfill just carries on after we redirect.
  const deps = buildDeps();
  const backfill = backfillUser(deps, user.id).catch(async (e) => {
    await logJobError(deps, user.id, "backfill", e);
    return null;
  });
  const summary = await Promise.race([backfill, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), WAIT_MS))]);
  if (summary === "timeout" || !summary) return done("/connected");
  return done(`/connected?m=${summary.meetings}&p=${summary.promisesMade}&o=${summary.stillOpen}`);
}
