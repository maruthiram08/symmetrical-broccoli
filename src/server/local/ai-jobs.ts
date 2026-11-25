// Background AI extras, run by the scheduler: daily nudges (after the brief) and the contradiction
// check on newly extracted decisions. Every model call is logged with its tokens and cost. Nothing
// here sends anything to anyone. Failures are logged and never stop the scheduler.
import { randomUUID } from "node:crypto";
import { safeCostInr } from "@/lib/ai/common";
import { CHECKS_PER_RUN, findCandidates, judge } from "@/lib/contradict/contradict";
import type { AnthropicLike } from "@/lib/extract/extract";
import { buildContext } from "@/lib/handoff/context";
import { NUDGE_DAILY_MAX, draftNudge, overdueWaiting, templateNudge } from "@/lib/nudge/nudge";
import type { Meeting, User } from "@/lib/types";
import { localClock } from "@/server/jobs/deliver";
import { logJobError } from "@/server/jobs/types";
import type { Store } from "@/server/store";
import type { AiStore } from "./ai-store";

export interface AiDeps {
  store: Store;
  ai: AiStore;
  /** Null when there is no API key: nudges fall back to the template and contradictions are skipped. */
  client: AnthropicLike | null;
  model: string;
  now: () => Date;
}

async function meetingsById(store: Store, userId: string): Promise<Map<string, Meeting>> {
  return new Map((await store.listMeetingsBetween(userId, "0000", "9999")).map((m) => [m.id, m]));
}

/**
 * Once a day, after today's brief went out: draft a nudge for each open "waiting on" item 3+ days
 * overdue that has none yet (at most NUDGE_DAILY_MAX). Cached nudges are kept; ones for items that
 * closed are dropped. Returns how many were drafted.
 */
export async function runNudges(deps: AiDeps, user: User): Promise<number> {
  const now = deps.now();
  const { date } = localClock(now, user.timeZone);
  if (deps.ai.nudgeDay() === date) return 0;
  if (!(await deps.store.getBrief(user.id, date))?.sentAt) return 0;

  const items = await deps.store.listItems(user.id);
  const due = overdueWaiting(items, now);
  deps.ai.pruneNudges(new Set(due.map((i) => i.id)));
  const meetings = await meetingsById(deps.store, user.id);
  let made = 0;
  for (const item of due) {
    if (made >= NUDGE_DAILY_MAX) break;
    if (deps.ai.nudge(item.id)) continue;
    const ctx = buildContext({ item, user, meetings, allItems: items, now });
    if (!ctx) continue;
    const r = deps.client ? await draftNudge(ctx, { client: deps.client, model: deps.model }) : { text: templateNudge(ctx), source: "template" as const, usage: null, fallback: "no api key" };
    deps.ai.saveNudge({ itemId: item.id, text: r.text, source: r.source, createdAt: now.toISOString() });
    made++;
    await deps.store.logEvent({
      userId: user.id, type: "nudge_draft", payload: { itemId: item.id, model: deps.model, fallback: r.fallback },
      ...(r.usage ? { tokensIn: r.usage.inputTokens, tokensOut: r.usage.outputTokens, costInr: safeCostInr(deps.model, r.usage) ?? undefined } : {}),
    });
  }
  deps.ai.setNudgeDay(date);
  return made;
}

/**
 * Compare decisions not checked yet with earlier ones. The very first run only records the
 * decisions already there (no model calls for history). A decision with no similar earlier one
 * costs nothing; otherwise one small call. Returns how many flags were raised.
 */
export async function runContradictions(deps: AiDeps, user: User): Promise<number> {
  const items = await deps.store.listItems(user.id);
  const decisions = items.filter((i) => i.kind === "decision" && i.status !== "wrong");
  if (!deps.ai.primed()) {
    deps.ai.markChecked(decisions.map((d) => d.id), true);
    return 0;
  }
  if (!deps.client) return 0;
  const checked = deps.ai.checkedSet();
  const fresh = decisions.filter((d) => !checked.has(d.id));
  if (!fresh.length) return 0;
  const meetings = await meetingsById(deps.store, user.id);
  const at = (d: (typeof fresh)[number]) => meetings.get(d.meetingId)?.startedAt ?? d.createdAt;
  fresh.sort((a, b) => at(a).localeCompare(at(b)));

  let calls = 0;
  let flagged = 0;
  for (const d of fresh) {
    const candidates = findCandidates(d, items, meetings);
    if (!candidates.length) { deps.ai.markChecked([d.id]); continue; }
    if (calls >= CHECKS_PER_RUN) break; // the rest wait for the next run
    calls++;
    const v = await judge(d, candidates, meetings, user.timeZone, { client: deps.client, model: deps.model });
    deps.ai.markChecked([d.id]);
    await deps.store.logEvent({
      userId: user.id, type: "contradiction_check", payload: { itemId: d.id, model: deps.model, candidates: candidates.length, flagged: !!v.oldId, error: v.error },
      ...(v.usage ? { tokensIn: v.usage.inputTokens, tokensOut: v.usage.outputTokens, costInr: safeCostInr(deps.model, v.usage) ?? undefined } : {}),
    });
    if (v.oldId) {
      deps.ai.addContradiction({ id: randomUUID(), newId: d.id, oldId: v.oldId, note: v.note, createdAt: deps.now().toISOString(), status: "open" });
      flagged++;
    }
  }
  return flagged;
}

/** Both jobs for every user. Never throws. */
export async function runAiJobs(deps: AiDeps, opts: { nudges?: boolean } = {}): Promise<void> {
  for (const user of await deps.store.listUsers()) {
    try { await runContradictions(deps, user); } catch (e) { await logJobError(deps, user.id, "contradictions", e); }
    if (opts.nudges === false) continue;
    try { await runNudges(deps, user); } catch (e) { await logJobError(deps, user.id, "nudges", e); }
  }
}
