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
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { env } from "../env";
import type { ExtractionInput, ExtractionResult } from "../types";
import { QUOTE_MAX } from "../types";
import { SYSTEM_PROMPT, TOOL_NAME, buildUserMessage } from "./prompt";

export const MAX_TOKENS = 8000;

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
        required: ["kind", "text", "person", "quote", "dueAt"],
        properties: {
          kind: { type: "string", enum: ["owe", "waiting", "decision"] },
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
}

export function postProcess(
  output: ModelOutput,
  input: ExtractionInput,
  report: PostProcessReport = { droppedItems: [], droppedCloses: [] },
): Omit<ExtractionResult, "usage"> {
  const { norm, map } = normalizeWithMap(input.transcript);
  const transcript = { raw: input.transcript, norm, map };
  const openIds = new Set(input.openItems.map((i) => i.id));

  const newItems: ExtractionResult["newItems"] = [];
  const seen = new Set<string>();
  for (const item of output.newItems) {
    const verbatim = findVerbatim(transcript, item.quote);
    if (!verbatim) {
      report.droppedItems.push({ item, reason: "quote not found in transcript" });
      continue;
    }
    const person = item.kind === "decision" ? null : item.person;
    const key = [item.kind, normalize(item.text), normalize(person ?? "")].join("|");
    if (seen.has(key)) {
      report.droppedItems.push({ item, reason: "duplicate" });
      continue;
    }
    seen.add(key);
    newItems.push({
      kind: item.kind,
      text: item.text,
      person,
      quote: truncateQuote(verbatim),
      dueAt: toIsoOrNull(item.dueAt),
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
  defaultClient ??= new Anthropic({ apiKey: env.anthropicKey });
  return defaultClient;
}

export async function extractMeeting(
  input: ExtractionInput,
  deps: { client?: AnthropicLike; model?: string; report?: PostProcessReport } = {},
): Promise<ExtractionResult> {
  const client = deps.client ?? getDefaultClient();
  const model = deps.model ?? env.extractionModel;

  const response = await client.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    tools: [TOOL],
    tool_choice: { type: "auto", disable_parallel_tool_use: true },
    messages: [{ role: "user", content: buildUserMessage(input) }],
  });

  const usage = {
    inputTokens:
      response.usage.input_tokens +
      (response.usage.cache_creation_input_tokens ?? 0) +
      (response.usage.cache_read_input_tokens ?? 0),
    outputTokens: response.usage.output_tokens,
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
