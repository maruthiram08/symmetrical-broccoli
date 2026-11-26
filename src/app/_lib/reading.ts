// Shared bits for the reading-pane pages: the model's context and small URL helpers.
import type { Ctx, Group } from "@/lib/reading/model";
import type { Meeting, User } from "@/lib/types";

export function readingCtx(user: User, meetings: Meeting[], now: Date): Ctx {
  return { meetings: new Map(meetings.map((m) => [m.id, m])), timeZone: user.timeZone, now };
}

/** The groups as the client needs them: keys and row ids. */
export function groupIds(groups: Group[]): Array<{ key: string; ids: string[] }> {
  return groups.map((g) => ({ key: g.key, ids: g.rows.map((r) => r.id) }));
}

/** Which group a row sits in, for the detail's breadcrumb. */
export function groupOf(groups: Group[], id: string): string | undefined {
  return groups.find((g) => g.rows.some((r) => r.id === id))?.label;
}

/** `path` with `params` set (empty values dropped). */
export function withParams(path: string, params: Record<string, string | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return `${path}${s ? `?${s}` : ""}`;
}
