// Extracts owe / waiting / decision items and closes from one meeting transcript.
//
// API notes (verified against @anthropic-ai/sdk 0.71 and current model docs):
// - Output is collected through a single tool whose input_schema is the output JSON schema.
// - tool_choice is {type: "auto"}, not a forced {type: "tool"}: the default model
//   (claude-sonnet-5-5), like claude-opus-5-5 and the Fable 5.1/5.2 models, returns a 400 for a
//   forced tool_choice. The system prompt tells the model to always call the tool, and a reply
//   without the tool call is an ExtractionError.
// - No `thinking` param is sent. Current models then run adaptive thinking, and thinking tokens
//   count toward max_tokens, so MAX_TOKENS leaves room above the ~2-3k tokens the JSON needs.
// - No temperature: claude-sonnet-5-5 returns a 400 for non-default sampling values (temperature,
//   top_p, top_k), and API version 2026-10-21 rejects them on every model. Decision stability comes
//   from the prompt (explicit agreement, fixed wording) and from dropping repeats here instead.
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { env } from "../env";
import type { ExtractionInput, ExtractionResult } from "../types";
import { QUOTE_MAX } from "../types";
import { SYSTEM_PROMPT, TOOL_NAME, buildUserMessage } from "./prompt";
import { withAnthropicRetry, type RetryOpts } from "./errors";

export const MAX_TOKENS = 8000;
/** One request may take this long before it counts as a (retryable) timeout. */
export const REQUEST_TIMEOUT_MS = 180_000;

/** The part of the Anthropic client this module uses, so tests can pass a fake. */
export interface AnthropicLike {
  messages: {
    create(
      body: Anthropic.MessageCreateParamsNonStreaming,
      options?: Anthropic.RequestOptions,
    ): PromiseLike<Anthropic.Message>;
  };
}

export class ExtractionError extends Error {
  constructor(message: string, readonly details?: unknown) {
    super(message);
    this.name = "ExtractionError";
  }
}

// ---------- output schema (JSON schema for the API, zod for validation) ----------

const nullableString = z
  .string()
  .nullable()
  .optional()
  .transform((v) => (v == null || v.trim() === "" ? null : v.trim()));

export const ModelOutputSchema = z.object({
  newItems: z.array(
    z.object({
      kind: z.enum(["owe", "waiting", "decision"]),
      text: z.string().trim().min(1),
      person: nullableString,
      quote: z.string().min(1),
      dueAt: nullableString,
      attribution: z
        .enum(["label", "content"])
        .nullable()
        .optional()
        .transform((v) => v ?? undefined),
      // Who promised whom. Optional so older outputs still parse; when given, postProcess drops
      // items between two other people (Maruthi, 2026-11-26: "conversation between two different
      // people and their tasks are being captured").
      madeBy: z.enum(["user", "other", "none"]).nullable().optional(),
      madeTo: z.enum(["user", "other", "room", "none"]).nullable().optional(),
    }),
  ),
  closes: z.array(z.object({ itemId: z.string().min(1), quote: z.string().min(1) })),
});
export type ModelOutput = z.infer<typeof ModelOutputSchema>;

export const OUTPUT_JSON_SCHEMA: Anthropic.Tool.InputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["newItems", "closes"],
  properties: {
    newItems: {
      type: "array",
      description: "New items involving the user found in this transcript.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "madeBy", "madeTo", "text", "person", "quote", "dueAt"],
        properties: {
          kind: { type: "string", enum: ["owe", "waiting", "decision"] },
          madeBy: {
            type: "string",
            enum: ["user", "other", "none"],
            description: 'Who takes the task on: "user" or "other" (someone else). "none" for decisions.',
          },
          madeTo: {
            type: "string",
            enum: ["user", "other", "room", "none"],
            description:
              'Who the task is promised to or asked by: "user", "other" (a specific person who is not the user), "room" (the group, nobody in particular). "none" for decisions.',
          },
          text: { type: "string", description: "Verb-first, short, in English." },
          person: {
            type: ["string", "null"],
            description: "The other person's name as said in the transcript; null for decisions.",
          },
          quote: {
            type: "string",
            description: `Verbatim span of the transcript, at most ${QUOTE_MAX} characters.`,
          },
          dueAt: {
            type: ["string", "null"],
            description: "ISO 8601 UTC timestamp ending in Z, or null when no deadline was given.",
          },
          attribution: {
            type: "string",
            enum: ["label", "content"],
            description:
              'Owe and waiting items: "label" when the speaker labels alone show who promised, "content" when transcript cues (who is addressed, I/you, replies, roles) decided it. Leave out for decisions.',
          },
        },
      },
    },
    closes: {
      type: "array",
      description: "Open items (by id) that this transcript clearly shows are done.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["itemId", "quote"],
        properties: {
          itemId: { type: "string", description: "An id from the open items list." },
          quote: {
            type: "string",
            description: `Verbatim span of the transcript, at most ${QUOTE_MAX} characters.`,
          },
        },
      },
    },
  },
};

const TOOL: Anthropic.Tool = {
  name: TOOL_NAME,
  description:
    "Record the items found in the meeting transcript for the user. Call exactly once, with empty lists if there is nothing to record.",
  input_schema: OUTPUT_JSON_SCHEMA,
};

// ---------- quote verification ----------

const CHAR_MAP: Record<string, string> = {
  "‘": "'", "’": "'", "‚": "'", "‛": "'", "′": "'", "`": "'",
  "“": '"', "”": '"', "„": '"', "‟": '"', "″": '"',
  "–": "-", "—": "-", "−": "-",
  "…": "...",
  " ": " ",
};

/**
 * Normalizes for matching: lower case, curly to straight quotes, dashes, ellipsis, and runs of
 * whitespace to one space. map[i] is the index in `s` of normalized character i.
 */
export function normalizeWithMap(s: string): { norm: string; map: number[] } {
  let norm = "";
  const map: number[] = [];
  let lastWasSpace = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (/\s/.test(ch) || ch === " ") {
      if (!lastWasSpace && norm.length > 0) {
        norm += " ";
        map.push(i);
      }
      lastWasSpace = true;
      continue;
    }
    lastWasSpace = false;
    const out = (CHAR_MAP[ch] ?? ch).toLowerCase();
    for (const c of out) {
      norm += c;
      map.push(i);
    }
  }
  if (norm.endsWith(" ")) {
    norm = norm.slice(0, -1);
    map.pop();
  }
  return { norm, map };
}

export function normalize(s: string): string {
  return normalizeWithMap(s).norm;
}

/** Strips quote marks the model may wrap around a quote. */
function unwrap(q: string): string {
  return q.trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
}

/**
 * Finds the quote in the transcript under normalization and returns the transcript's own text
 * for that span (so stored quotes are truly verbatim), or null when it is not there.
 */
export function findVerbatim(
  transcript: { raw: string; norm: string; map: number[] },
  quote: string,
): string | null {
  for (const candidate of [quote.trim(), unwrap(quote)]) {
    const q = normalize(candidate);
    if (!q) continue;
    const at = transcript.norm.indexOf(q);
    if (at === -1) continue;
    const start = transcript.map[at];
    const end = transcript.map[at + q.length - 1] + 1;
    return transcript.raw.slice(start, end);
  }
  return null;
}

/** Cuts to at most `max` characters, at a word boundary when there is one. */
export function truncateQuote(q: string, max = QUOTE_MAX): string {
  const s = q.trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max + 1);
  const lastSpace = cut.lastIndexOf(" ");
  const out = lastSpace > max / 2 ? cut.slice(0, lastSpace) : s.slice(0, max);
  return out.replace(/[\s,;:\-]+$/, "");
}

function toIsoOrNull(v: string | null): string | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

// ---------- post-processing ----------

export interface PostProcessReport {
  droppedItems: Array<{ item: ModelOutput["newItems"][number]; reason: string }>;
  droppedCloses: Array<{ close: ModelOutput["closes"][number]; reason: string }>;
  /** Prompt-cache tokens of the call (already counted in usage.inputTokens), for exact eval costs. */
  cache?: { readTokens: number; writeTokens: number };
}

// ---------- decision repeats ----------

const DECISION_STOPWORDS = new Set(
  "a an the to of for and or in on at by with from as is are be it this that we will let should".split(" "),
);

/** Words that flip or narrow a choice. Two decisions that differ in these are different decisions. */
const POLARITY = new Set("not no without never dont don't skip drop remove instead only except exclude".split(" "));

function decisionWords(text: string): Set<string> {
  return new Set(
    normalize(text)
      .replace(/([a-z0-9])-(?=[a-z0-9])/g, "$1")
      .split(/[^\p{L}\p{N}']+/u)
      .map((w) => w.replace(/'s$/, ""))
      .filter((w) => w.length > 1 && !DECISION_STOPWORDS.has(w))
      .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w)),
  );
}

/**
 * Two decision texts say the same thing: equal after normalizing, or sharing at least 80% of their
 * content words (Dice) with the same negations ("without", "skip", "only"...). Strict on purpose: a changed decision ("web only" -> "web and mobile") must
 * still get through, because the changed-decision check needs it.
 */
export function sameDecision(a: string, b: string): boolean {
  if (normalize(a) === normalize(b)) return true;
  const A = decisionWords(a);
  const B = decisionWords(b);
  if (A.size < 2 || B.size < 2) return false;
  // "with the tooltip" and "without the tooltip" share most words but are opposite choices.
  const polarity = (S: Set<string>) => [...S].filter((w) => POLARITY.has(w)).sort().join(" ");
  if (polarity(A) !== polarity(B)) return false;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return (2 * shared) / (A.size + B.size) >= 0.8;
}

/**
 * Why an owe or waiting item isn't the user's, or null when it is (or the model didn't say).
 * owe: the user must take it on. waiting: someone else takes it on, for the user or the room;
 * a promise from one other person to another is theirs, not the user's.
 */
export function notTheUsers(item: ModelOutput["newItems"][number]): string | null {
  const { kind, madeBy, madeTo } = item;
  if (kind === "decision") return null;
  if (kind === "owe" && madeBy && madeBy !== "user") return "owe item the user did not take on";
  if (kind === "owe" && madeTo === "user") return "owe item made to the user";
  if (kind === "waiting" && madeBy === "user") return "waiting item the user took on";
  if (kind === "waiting" && madeTo === "other") return "promise between two other people";
  return null;
}

export function postProcess(
  output: ModelOutput,
  input: ExtractionInput,
  report: PostProcessReport = { droppedItems: [], droppedCloses: [] },
): Omit<ExtractionResult, "usage"> {
  const { norm, map } = normalizeWithMap(input.transcript);
  const transcript = { raw: input.transcript, norm, map };
  const openIds = new Set(input.openItems.map((i) => i.id));
  const earlierDecisions = input.openDecisions ?? [];

  const newItems: ExtractionResult["newItems"] = [];
  const seen = new Set<string>();
  for (const item of output.newItems) {
    const verbatim = findVerbatim(transcript, item.quote);
    if (!verbatim) {
      report.droppedItems.push({ item, reason: "quote not found in transcript" });
      continue;
    }
    const notMine = notTheUsers(item);
    if (notMine) {
      report.droppedItems.push({ item, reason: notMine });
      continue;
    }
    const person = item.kind === "decision" ? null : item.person;
    const key = [item.kind, normalize(item.text), normalize(person ?? "")].join("|");
    if (seen.has(key)) {
      report.droppedItems.push({ item, reason: "duplicate" });
      continue;
    }
    if (item.kind === "decision") {
      if (earlierDecisions.some((d) => sameDecision(d.text, item.text))) {
        report.droppedItems.push({ item, reason: "repeats an earlier decision" });
        continue;
      }
      if (newItems.some((n) => n.kind === "decision" && sameDecision(n.text, item.text))) {
        report.droppedItems.push({ item, reason: "duplicate" });
        continue;
      }
    }
    seen.add(key);
    newItems.push({
      kind: item.kind,
      text: item.text,
      person,
      quote: truncateQuote(verbatim),
      dueAt: toIsoOrNull(item.dueAt),
      ...(item.kind !== "decision" && item.attribution ? { attribution: item.attribution } : {}),
    });
  }

  const closes: ExtractionResult["closes"] = [];
  const closed = new Set<string>();
  for (const close of output.closes) {
    if (!openIds.has(close.itemId)) {
      report.droppedCloses.push({ close, reason: "unknown item id" });
      continue;
    }
    if (closed.has(close.itemId)) {
      report.droppedCloses.push({ close, reason: "duplicate" });
      continue;
    }
    const verbatim = findVerbatim(transcript, close.quote);
    if (!verbatim) {
      report.droppedCloses.push({ close, reason: "quote not found in transcript" });
      continue;
    }
    closed.add(close.itemId);
    closes.push({ itemId: close.itemId, quote: truncateQuote(verbatim) });
  }

  return { newItems, closes };
}

// ---------- the call ----------

let defaultClient: Anthropic | null = null;
function getDefaultClient(): Anthropic {
  // Retries are ours (withAnthropicRetry), so they can be classified and tested.
  defaultClient ??= new Anthropic({ apiKey: env.anthropicKey, maxRetries: 0, timeout: REQUEST_TIMEOUT_MS });
  return defaultClient;
}

export async function extractMeeting(
  input: ExtractionInput,
  deps: {
    client?: AnthropicLike;
    model?: string;
    report?: PostProcessReport;
    retry?: RetryOpts;
    /** Eval only: another system prompt (the baseline, to compare prompts on the same harness). */
    system?: string;
    /** Eval only: cache the whole request, for reading the same meeting again within 5 minutes. */
    cacheRequest?: boolean;
  } = {},
): Promise<ExtractionResult> {
  const model = deps.model ?? env.extractionModel;
  const text = buildUserMessage(input);
  const body: Anthropic.MessageCreateParamsNonStreaming = {
    model,
    max_tokens: MAX_TOKENS,
    system: deps.system ?? SYSTEM_PROMPT,
    tools: [TOOL],
    tool_choice: { type: "auto", disable_parallel_tool_use: true },
    messages: [
      {
        role: "user",
        content: deps.cacheRequest ? [{ type: "text", text, cache_control: { type: "ephemeral" } }] : text,
      },
    ],
  };
  // A missing key surfaces as an auth failure, like a rejected one.
  const response = await withAnthropicRetry(() => {
    let client: AnthropicLike;
    try {
      client = deps.client ?? getDefaultClient();
    } catch {
      throw Object.assign(new Error("ANTHROPIC_API_KEY is not set"), { status: 401 });
    }
    return client.messages.create(body);
  }, deps.retry);

  const usage = {
    inputTokens:
      response.usage.input_tokens +
      (response.usage.cache_creation_input_tokens ?? 0) +
      (response.usage.cache_read_input_tokens ?? 0),
    outputTokens: response.usage.output_tokens,
  };
  if (deps.report)
    deps.report.cache = {
      readTokens: response.usage.cache_read_input_tokens ?? 0,
      writeTokens: response.usage.cache_creation_input_tokens ?? 0,
    };

  const stop = response.stop_reason as string | null;
  if (stop === "max_tokens") {
    throw new ExtractionError(
      `Extraction hit max_tokens (${MAX_TOKENS}) before finishing; the output was cut off.`,
      { usage },
    );
  }
  if (stop === "refusal") {
    throw new ExtractionError("The model declined to process this transcript (stop_reason: refusal).", {
      usage,
      stop_details: (response as unknown as { stop_details?: unknown }).stop_details,
    });
  }

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === TOOL_NAME,
  );
  if (!toolUse) {
    throw new ExtractionError(
      `Model did not call ${TOOL_NAME} (stop_reason: ${stop ?? "null"}).`,
      { usage, content: response.content },
    );
  }

  const parsed = ModelOutputSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new ExtractionError(`Model output failed validation: ${issues}`, {
      usage,
      input: toolUse.input,
    });
  }

  return { ...postProcess(parsed.data, input, deps.report), usage };
}
