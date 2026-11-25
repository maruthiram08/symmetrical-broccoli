import type { Connection, User } from "@/lib/types";

/**
 * Where a first run stands. "about" = no name yet, "connect" = Wispr Flow not connected,
 * "read" = connected but nothing read yet (the first read hasn't started), "done" = past onboarding.
 * A reconnect (connection marked needs_reconnect) is not onboarding: Today shows its own banner.
 */
export type OnboardingStep = "about" | "connect" | "read" | "done";

export function onboardingStep(user: User | null, conn: Connection | null, reading: boolean): OnboardingStep {
  if (!user || !user.name.trim()) return "about";
  if (!conn) return "connect";
  // lastSeenAt is set by the first poll, so a started (or finished) first read leaves onboarding.
  if (conn.lastSeenAt === null && !reading) return "read";
  return "done";
}
