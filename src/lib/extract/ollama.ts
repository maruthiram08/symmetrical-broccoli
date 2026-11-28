// On-device extraction with Ollama (https://ollama.com), an alternative to Claude.
//
// Same prompt, same output schema and the same post-processing as extract.ts: the tool's
// input_schema goes to Ollama's `format` (structured JSON output), and the system prompt asks for
// that JSON instead of a tool call. Quotes the model makes up are still dropped by postProcess,
// because every quote must be found in the transcript. Smaller local models miss more promises.
import type { ExtractionInput, ExtractionResult } from "../types";
import { AnthropicCallError } from "./errors";
import { ExtractionError, ModelOutputSchema, OUTPUT_JSON_SCHEMA, postProcess, type PostProcessReport } from "./extract";
import { SYSTEM_PROMPT, TOOL_NAME, buildUserMessage } from "./prompt";

const TOOL_LINE = `Record your answer by calling the ${TOOL_NAME} tool exactly once. Do not answer in plain text.`;

export const OLLAMA_SYSTEM_PROMPT = SYSTEM_PROMPT.replace(
  TOOL_LINE,
  `Answer with one JSON object and nothing else. It is the input of the ${TOOL_NAME} tool and must match this JSON schema:\n${JSON.stringify(OUTPUT_JSON_SCHEMA)}`,
);

export const OLLAMA_TIMEOUT_MS = 10 * 60_000;
/** Long meetings need a big context window; Ollama's default (2-4k tokens) would cut the transcript. */
export const OLLAMA_NUM_CTX = 32_768;

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

interface ChatResponse {
  message?: { content?: string };
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

export async function extractMeetingOllama(
  input: ExtractionInput,
  deps: { url: string; model: string; fetch?: FetchLike; report?: PostProcessReport; timeoutMs?: number },
): Promise<ExtractionResult> {
  const doFetch = deps.fetch ?? (fetch as unknown as FetchLike);
  const body = {
    model: deps.model,
    stream: false,
    format: OUTPUT_JSON_SCHEMA,
    options: { temperature: 0, num_ctx: OLLAMA_NUM_CTX },
    messages: [
      { role: "system", content: OLLAMA_SYSTEM_PROMPT },
      { role: "user", content: buildUserMessage(input) },
    ],
  };
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await doFetch(`${deps.url.replace(/\/+$/, "")}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(deps.timeoutMs ?? OLLAMA_TIMEOUT_MS),
    });
  } catch {
    // Ollama isn't running (or timed out): counted as a failed try, read again on a later check,
    // and set aside with a Retry button after a few. Never flagged as an Anthropic key problem.
    throw new AnthropicCallError("transient", null);
  }
  if (res.status === 404) throw new ExtractionError(`Ollama doesn't have the model "${deps.model}". Run: ollama pull ${deps.model}`);
  if (res.status >= 500) throw new AnthropicCallError("transient", res.status);
  if (!res.ok) throw new ExtractionError(`Ollama answered HTTP ${res.status}.`);

  const data = (await res.json()) as ChatResponse;
  const usage = { inputTokens: data.prompt_eval_count ?? 0, outputTokens: data.eval_count ?? 0 };
  if (data.done_reason === "length") throw new ExtractionError("The local model ran out of room before finishing.", { usage });
  let json: unknown;
  try {
    json = JSON.parse(data.message?.content ?? "");
  } catch {
    throw new ExtractionError("The local model didn't answer with JSON.", { usage });
  }
  const parsed = ModelOutputSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new ExtractionError(`Local model output failed validation: ${issues}`, { usage });
  }
  return { ...postProcess(parsed.data, input, deps.report), usage };
}

/** Settings' "Test": is Ollama there, and does it have the model? Never throws. */
export async function checkOllama(url: string, model: string, doFetch: FetchLike = fetch as unknown as FetchLike): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await (doFetch as unknown as (u: string, i?: { signal?: AbortSignal }) => ReturnType<FetchLike>)(`${url.replace(/\/+$/, "")}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { ok: false, message: `Ollama answered HTTP ${res.status}.` };
    const names = (((await res.json()) as { models?: Array<{ name?: string }> }).models ?? []).map((m) => m.name ?? "");
    const want = model.includes(":") ? model : `${model}:latest`;
    if (names.includes(model) || names.includes(want)) return { ok: true, message: `Ollama is running and has ${model}.` };
    return { ok: false, message: `Ollama is running but doesn't have ${model}. Run: ollama pull ${model}` };
  } catch {
    return { ok: false, message: `Couldn't reach Ollama at ${url}. Is it running? (ollama serve)` };
  }
}
