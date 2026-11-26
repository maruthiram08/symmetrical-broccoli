import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { buildDeps, getStore, me, wisprAuthContext } from "@/server/local/app";
import { appUrl } from "@/server/local/paths";
import { backfillUser } from "@/server/jobs/backfill";
import { runExclusive } from "@/server/local/scheduler";
import { logJobError } from "@/server/jobs/types";
import { finishWisprAuth, openPending, PENDING_COOKIE } from "@/server/wispr/oauth";
import { errLine } from "@/server/local/log";
import { getWorkspace, WORKSPACE_COOKIE, withWorkspace } from "@/server/local/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const WAIT_MS = 45_000;

function done(path: string) {
  const res = NextResponse.redirect(new URL(path, appUrl()));
  res.cookies.set(PENDING_COOKIE, "", { path: "/api/wispr", maxAge: 0 });
  res.cookies.set(WORKSPACE_COOKIE, "", { path: "/api/wispr", maxAge: 0 });
  return res;
}

// Finishes OAuth and saves the connection. On a first run it returns to /welcome (step 3 picks the
// range to read); on a reconnect it reads the last 7 days, then shows the Connected page.
export async function GET(req: Request) {
  const ws = getWorkspace((await cookies()).get(WORKSPACE_COOKIE)?.value ?? "");
  return ws ? withWorkspace(ws, () => finish(req)) : finish(req);
}

async function finish(req: Request) {
  const url = new URL(req.url);
  const user = await me();
  // First run (nothing read yet): back to /welcome, whose step 3 asks how far back to read.
  const before = user ? await getStore().getConnection(user.id) : null;
  const firstRun = !before || before.lastSeenAt === null;
  const failed = firstRun ? "/welcome?error=wispr" : "/setup?error=wispr";
  if (url.searchParams.get("error")) return done(failed);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state || !user) return done(failed);

  try {
    const pending = openPending((await cookies()).get(PENDING_COOKIE)?.value, new Date());
    await finishWisprAuth(wisprAuthContext(user.id), { pending, code, state });
  } catch (e) {
    console.error(`[wispr/callback] ${errLine(e)}`);
    return done(failed);
  }
  if (firstRun) return done("/welcome");

  // The app keeps running, so a slow backfill just carries on after we redirect.
  const deps = buildDeps();
  const backfill = runExclusive(() => backfillUser(deps, user.id)).catch(async (e) => {
    await logJobError(deps, user.id, "backfill", e);
    return null;
  });
  const summary = await Promise.race([backfill, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), WAIT_MS))]);
  if (summary === "timeout" || !summary) return done("/connected");
  return done(`/connected?m=${summary.meetings}&p=${summary.promisesMade}&o=${summary.stillOpen}`);
}
