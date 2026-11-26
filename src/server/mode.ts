// Which way the app runs. "local" (default): one user on this Mac, data in a JSON file, the
// in-process scheduler. "hosted": many users on Vercel + Supabase, magic-link sign-in, cron routes.
// Set with DAILY_BRIEF_MODE=local|hosted. Anything else (or unset) is local, so the Mac app never
// changes behaviour by accident.
export type AppMode = "local" | "hosted";

export function appMode(env: Record<string, string | undefined> = process.env): AppMode {
  return env.DAILY_BRIEF_MODE?.trim().toLowerCase() === "hosted" ? "hosted" : "local";
}

export const isHosted = (env?: Record<string, string | undefined>) => appMode(env) === "hosted";
