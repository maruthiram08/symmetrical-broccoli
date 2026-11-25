import { after, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { buildDeps, wisprAuthContext } from "@/server/deps";
import { backfillUser } from "@/server/jobs/backfill";
import { logJobError } from "@/server/jobs/types";
import { getSessionUserId, readCookie } from "@/server/session";
import { finishWisprAuth, openPending, PENDING_COOKIE } from "@/server/wispr/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // a slow backfill keeps running after the response
const WAIT_MS = 45_000;

function done(path: string) {
  const res = NextResponse.redirect(new URL(path, env.appUrl));
  res.cookies.set(PENDING_COOKIE, "", { path: "/api/wispr", maxAge: 0 });
  return res;
}

// Finishes OAuth, saves the connection, backfills the last 7 days, redirects to /connected.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const userId = getSessionUserId(req);
  if (url.searchParams.get("error")) return done("/setup?error=wispr"); // user denied access, or Wispr Flow reported an error
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state || !userId) return done(userId ? "/setup?error=wispr" : "/");

  try {
    const pending = openPending(readCookie(req, PENDING_COOKIE), new Date());
    await finishWisprAuth(wisprAuthContext(userId), { pending, code, state });
  } catch (e) {
    console.error("[wispr/callback]", e instanceof Error ? e.message : e);
    return done("/setup?error=wispr");
  }

  // The Connected page shows the backfill totals from ?m=&p=&o=. Wait for the backfill a little;
  // if it takes longer, finish it after the response and send the user on without totals.
  const deps = buildDeps();
  const backfill = backfillUser(deps, userId).catch(async (e) => {
    await logJobError(deps, userId, "backfill", e);
    return null;
  });
  const summary = await Promise.race([backfill, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), WAIT_MS))]);
  if (summary === "timeout") {
    after(() => backfill.then(() => undefined));
    return done("/connected");
  }
  if (!summary) return done("/connected");
  return done(`/connected?m=${summary.meetings}&p=${summary.promisesMade}&o=${summary.stillOpen}`);
}
