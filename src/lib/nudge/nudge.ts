// Nudges: for things you're waiting on that are 3+ days overdue, a short friendly Slack-style
// nudge in your voice. Drafted once per item (the caller caches it), never sent: you copy it.
// Reuses the "Start this" context, template and checks (src/lib/handoff).
import type Anthropic from "@anthropic-ai/sdk";
import type { AnthropicLike } from "../extract/extract";
import { usageOf, toolInput, type Usage } from "../ai/common";
import { meetingLabel } from "../handoff/format";
import { isHinglish } from "../handoff/lang";
import { textProblems } from "../handoff/draft";
import { templateDraft } from "../handoff/template";
import type { HandoffContext } from "../handoff/types";
import type { Item } from "../types";

export const NUDGE_OVERDUE_DAYS = 3;
export const NUDGE_MAX_WORDS = 50;
export const NUDGE_MAX_TOKENS = 1500;
/** Most nudges drafted in one daily run, as a cost guard. */
export const NUDGE_DAILY_MAX = 10;
const TOOL_NAME = "write_nudge";
const DAY_MS = 86_400_000;

/** Open "waiting on" items whose due date passed at least `days` ago, most overdue first. */
export function overdueWaiting(items: Item[], now: Date, days = NUDGE_OVERDUE_DAYS): Item[] {
  const cutoff = now.getTime() - days * DAY_MS;
  return items
    .filter((i) => i.kind === "waiting" && i.status === "open" && i.dueAt && Date.parse(i.dueAt) <= cutoff)
    .sort((a, b) => Date.parse(a.dueAt!) - Date.parse(b.dueAt!));
}

export const daysOverdue = (dueAt: string, now: Date) => Math.max(0, Math.floor((now.getTime() - Date.parse(dueAt)) / DAY_MS));

export const NUDGE_SYSTEM_PROMPT = `You draft one short Slack message that a busy person (the "user") will send a colleague who promised them something in a meeting and is now a few days late. You only draft: the user reads, edits and sends it.

Record the message by calling the ${TOOL_NAME} tool exactly once. Do not answer in plain text.

The message
- A friendly nudge: mention what they said they'd do, lightly, and ask for an update or a new date. Warm, never passive-aggressive, no guilt, don't mention how many days late it is.
- Under ${NUDGE_MAX_WORDS} words, one or two sentences, starting "Hey <first name>," (or "Hi <first name>,"). No sign-off.
- Write as the user: first person, plain, casual Slack tone. Indian English is fine ("any update on this?", "do let me know").
- Use Hinglish only if the request says the quote is Hinglish, and keep it light ("koi update?"). Otherwise plain English.
- You may echo a few words of what they said, but don't paste the whole quote.
- No emoji, no exclamation marks, no placeholders like [name] or <link>, no markdown, no filler like "I hope this finds you well" or "just circling back".
- Never invent dates, numbers or facts.`;

const TOOL: Anthropic.Tool = {
  name: TOOL_NAME,
  description: "Record the Slack nudge. Call exactly once.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["message"],
    properties: { message: { type: "string", description: `The Slack message, under ${NUDGE_MAX_WORDS} words.` } },
  },
};

export function buildNudgeMessage(ctx: HandoffContext): string {
  return `User: ${ctx.user.name}
Person: ${ctx.item.person ?? "(not named)"}
What they promised: ${ctx.item.text}
Meeting: ${meetingLabel(ctx) ?? "(unknown)"}
Days past the due date: ${ctx.item.dueAt ? daysOverdue(ctx.item.dueAt, new Date(ctx.now)) : "unknown"}
Quote from the meeting (verbatim): "${ctx.item.quote}"
Quote is Hinglish: ${isHinglish(ctx.item.quote) ? "yes" : "no"}`;
}

export interface NudgeDraft {
  text: string;
  source: "ai" | "template";
  usage: Usage | null;
  /** Why the template was used, for logs (never message text). */
  fallback: string | null;
}

export function templateNudge(ctx: HandoffContext): string {
  return templateDraft(ctx).slack;
}

/** One model call; falls back to the "Start this" template on any failure or a draft that fails the checks. */
export async function draftNudge(ctx: HandoffContext, deps: { client: AnthropicLike; model: string }): Promise<NudgeDraft> {
  const fallback = (why: string, usage: Usage | null = null): NudgeDraft => ({ text: templateNudge(ctx), source: "template", usage, fallback: why });
  let r: Anthropic.Message;
  try {
    r = await deps.client.messages.create({
      model: deps.model,
      max_tokens: NUDGE_MAX_TOKENS,
      system: NUDGE_SYSTEM_PROMPT,
      tools: [TOOL],
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      messages: [{ role: "user", content: buildNudgeMessage(ctx) }],
    });
  } catch (e) {
    return fallback(`api error: ${e instanceof Error ? e.name : "unknown"}`);
  }
  const usage = usageOf(r);
  const stop = r.stop_reason as string | null;
  if (stop === "max_tokens" || stop === "refusal") return fallback(`stop_reason ${stop}`, usage);
  const input = toolInput(r, TOOL_NAME) as { message?: unknown } | null;
  const text = typeof input?.message === "string" ? input.message.trim() : "";
  if (!text) return fallback("no tool call", usage);
  const problems = textProblems(text, { maxWords: NUDGE_MAX_WORDS, quoteIsHinglish: isHinglish(ctx.item.quote) });
  if (problems.length) return fallback(`checks: ${problems.join(", ")}`, usage);
  return { text, source: "ai", usage, fallback: null };
}
