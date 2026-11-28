// Drafts Slack and email messages for one item with a single Claude call, validated, with a
// template fallback. Same API approach as src/lib/extract/extract.ts: one tool whose input is the
// output, tool_choice auto (the default model rejects a forced tool_choice), no thinking param.
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { AnthropicLike } from "../extract/extract";
import { contextPack } from "./pack";
import { DRAFT_SYSTEM_PROMPT, DRAFT_TOOL_NAME, EMAIL_MAX_WORDS, SLACK_MAX_WORDS, SUBJECT_MAX_CHARS, buildDraftMessage } from "./prompt";
import { templateDraft } from "./template";
import { isHinglish } from "./lang";
import { wordCount } from "./format";
import type { Drafts, HandoffContext } from "./types";

export const DRAFT_MAX_TOKENS = 3000;

const TOOL: Anthropic.Tool = {
  name: DRAFT_TOOL_NAME,
  description: "Record the Slack and email drafts. Call exactly once.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["slack", "email_subject", "email_body"],
    properties: {
      slack: { type: "string", description: `Slack DM, under ${SLACK_MAX_WORDS} words.` },
      email_subject: { type: "string", description: "Email subject, sentence case, under 60 characters." },
      email_body: { type: "string", description: `Email body, under ${EMAIL_MAX_WORDS} words.` },
    },
  },
};

const OutputSchema = z.object({
  slack: z.string().trim().min(1),
  email_subject: z.string().trim().min(1),
  email_body: z.string().trim().min(1),
});

const BANNED: RegExp[] = [
  /hope (this|that|my) (message |email |note )?finds you/i,
  /hope you('| a)re (doing )?(well|good)/i,
  /hope you are (doing )?(well|good)/i,
  /circling back/i,
  /per my last/i,
  /^\s*dear\b/i,
  /as an ai\b/i,
  /\[[^\]]*\]/, // [name], [link]
  /<[^>]+>/, // <name>
  /\{[^}]*\}/, // {name}
  /\p{Extended_Pictographic}/u,
  /!/,
  /\*\*|^#+\s/m,
];

/** Problems with one piece of drafted text, or [] when it is fine. */
export function textProblems(s: string, opts: { maxWords: number; quoteIsHinglish: boolean }): string[] {
  const out: string[] = [];
  if (!s.trim()) out.push("empty");
  if (wordCount(s) > opts.maxWords) out.push(`over ${opts.maxWords} words`);
  for (const re of BANNED) if (re.test(s)) out.push(`matches ${re}`);
  if (!opts.quoteIsHinglish && /[ऀ-ॿ]/.test(s)) out.push("Devanagari without a Hindi quote");
  if (!opts.quoteIsHinglish && isHinglish(s)) out.push("Hinglish without a Hinglish quote");
  return out;
}

export interface DraftValidation {
  slack: string[];
  email: string[];
}

export function validateDrafts(d: { slack: string; email_subject: string; email_body: string }, ctx: HandoffContext): DraftValidation {
  const quoteIsHinglish = isHinglish(ctx.item.quote);
  const email = [
    ...textProblems(d.email_subject, { maxWords: 14, quoteIsHinglish }),
    ...textProblems(d.email_body, { maxWords: EMAIL_MAX_WORDS, quoteIsHinglish }),
  ];
  if (d.email_subject.length > SUBJECT_MAX_CHARS) email.push("subject too long");
  if (/\n/.test(d.email_subject)) email.push("subject has a line break");
  return { slack: textProblems(d.slack, { maxWords: SLACK_MAX_WORDS, quoteIsHinglish }), email };
}

export interface DraftResult {
  drafts: Drafts;
  usage: { inputTokens: number; outputTokens: number } | null;
  /** Why a template was used, for logs (never contains message text). */
  fallback: string | null;
}

/** Template drafts for everything. */
export function templateDrafts(ctx: HandoffContext): Drafts {
  const t = templateDraft(ctx);
  return { ...t, slackSource: "template", emailSource: "template", claudePrompt: contextPack(ctx) };
}

export async function draftHandoff(ctx: HandoffContext, deps: { client: AnthropicLike; model: string }): Promise<DraftResult> {
  const fallback = (why: string, usage: DraftResult["usage"] = null): DraftResult => ({ drafts: templateDrafts(ctx), usage, fallback: why });

  let response: Anthropic.Message;
  try {
    response = await deps.client.messages.create({
      model: deps.model,
      max_tokens: DRAFT_MAX_TOKENS,
      system: DRAFT_SYSTEM_PROMPT,
      tools: [TOOL],
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      messages: [{ role: "user", content: buildDraftMessage(ctx) }],
    });
  } catch (e) {
    return fallback(`api error: ${e instanceof Error ? e.name : "unknown"}`);
  }

  const usage = {
    inputTokens:
      response.usage.input_tokens + (response.usage.cache_creation_input_tokens ?? 0) + (response.usage.cache_read_input_tokens ?? 0),
    outputTokens: response.usage.output_tokens,
  };
  const stop = response.stop_reason as string | null;
  if (stop === "max_tokens" || stop === "refusal") return fallback(`stop_reason ${stop}`, usage);

  const tool = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === DRAFT_TOOL_NAME);
  if (!tool) return fallback("no tool call", usage);
  const parsed = OutputSchema.safeParse(tool.input);
  if (!parsed.success) return fallback("schema", usage);

  const problems = validateDrafts(parsed.data, ctx);
  const t = templateDraft(ctx);
  const slackOk = problems.slack.length === 0;
  const emailOk = problems.email.length === 0;
  const drafts: Drafts = {
    slack: slackOk ? parsed.data.slack : t.slack,
    emailSubject: emailOk ? parsed.data.email_subject : t.emailSubject,
    emailBody: emailOk ? parsed.data.email_body : t.emailBody,
    slackSource: slackOk ? "ai" : "template",
    emailSource: emailOk ? "ai" : "template",
    claudePrompt: contextPack(ctx),
  };
  const why = [...(slackOk ? [] : [`slack: ${problems.slack.join(", ")}`]), ...(emailOk ? [] : [`email: ${problems.email.join(", ")}`])];
  return { drafts, usage, fallback: why.length ? why.join("; ") : null };
}
