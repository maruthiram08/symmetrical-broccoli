// Every provider behind the Anthropic client's shape (messages.create and messages.stream), so
// extraction, Ask, writing assist, nudges and the contradiction check run unchanged on any of them.
//
// A request with one tool is structured output:
// - "tool" mode sends it as a function the model must call (a forced tool choice);
// - "json_schema" mode sends the tool's input_schema as the response format and asks for that JSON.
// Either way the answer comes back as a tool_use block with the tool's name, so the caller's own
// validation (zod) and the quote check (postProcess) apply exactly as for Claude. A reply that skips
// the tool but is a JSON object is taken as the tool input too.
//
// Errors come out as AnthropicCallError (kind + status only, never a response body), classified by
// classifyProviderError, so the existing retries and "fix your key" banners work the same.
import type Anthropic from "@anthropic-ai/sdk";
import type { AnthropicLike } from "../extract/extract";
import type { StreamingClient } from "../ask/ask";
import { toCallError } from "./errors";
import { parseJsonObject, strictSchema, withoutAdditional } from "./schema";
import { splitModel, type ProviderId, type StructuredMode } from "./providers";

export type AiClient = AnthropicLike & StreamingClient;

type Params = Anthropic.MessageCreateParamsNonStreaming;
type Json = Record<string, unknown>;

/** A request in plain terms, the same for every provider. */
export interface Neutral {
  model: string;
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  maxTokens: number;
  tool: Anthropic.Tool | null;
}

export interface NeutralResult {
  text: string;
  /** The structured output (from a tool call or a JSON reply), when a tool was asked for. */
  toolInput?: unknown;
  stop: "end" | "length" | "refusal";
  usage: { input: number; output: number };
}

export interface Backend {
  call(req: Neutral, mode: StructuredMode, signal?: AbortSignal): Promise<NeutralResult>;
  /** Text deltas; the last value returned is the usage. */
  stream(req: Neutral, signal?: AbortSignal): AsyncGenerator<string, NeutralResult["usage"] & { stop?: NeutralResult["stop"] }>;
}

const textOf = (c: Params["messages"][number]["content"]): string =>
  typeof c === "string" ? c : c.map((b) => ("text" in b && typeof b.text === "string" ? b.text : "")).join("\n");

export function toNeutral(body: Params | Anthropic.MessageStreamParams, provider: ProviderId): Neutral {
  const sys = body.system;
  const system = !sys ? "" : typeof sys === "string" ? sys : sys.map((b) => b.text).join("\n");
  const tool = (body.tools ?? []).find((t): t is Anthropic.Tool => "input_schema" in t) ?? null;
  const { provider: p, model } = splitModel(body.model);
  return {
    model: p === provider ? model : body.model,
    system,
    messages: body.messages.map((m) => ({ role: m.role, content: textOf(m.content) })),
    maxTokens: body.max_tokens,
    tool,
  };
}

/** The system prompt for json_schema mode: the same instructions, with "answer in JSON" for the tool call. */
export function jsonSystem(system: string, tool: Anthropic.Tool): string {
  const line = new RegExp(`Record (?:your answer|the [a-z ]+?) by calling the ${tool.name} tool exactly once\\. Do not answer in plain text\\.`);
  const ask = `Answer with one JSON object and nothing else. It is the input of the ${tool.name} tool and must match the JSON schema you were given.`;
  return line.test(system) ? system.replace(line, ask) : `${system}\n\n${ask}`;
}

export function toMessage(r: NeutralResult, req: Neutral): Anthropic.Message {
  let input = r.toolInput;
  if (req.tool && input === undefined) input = parseJsonObject(r.text) ?? undefined;
  const content: Anthropic.ContentBlock[] = req.tool && input !== undefined
    ? [{ type: "tool_use", id: "toolu_adapter", name: req.tool.name, input } as Anthropic.ContentBlock]
    : [{ type: "text", text: r.text, citations: null } as Anthropic.ContentBlock];
  const stop = r.stop === "length" ? "max_tokens" : r.stop === "refusal" ? "refusal" : content[0].type === "tool_use" ? "tool_use" : "end_turn";
  return {
    id: "msg_adapter", type: "message", role: "assistant", model: req.model, content,
    stop_reason: stop as Anthropic.Message["stop_reason"], stop_sequence: null,
    usage: { input_tokens: r.usage.input, output_tokens: r.usage.output, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: null },
  } as Anthropic.Message;
}

const isAbort = (e: unknown, signal?: AbortSignal) => !!signal?.aborted || (e as { name?: string })?.name === "AbortError";

/** Wraps a backend as an Anthropic-shaped client. */
export function adapt(provider: ProviderId, backend: Backend, mode: StructuredMode): AiClient {
  return {
    messages: {
      async create(body, options) {
        const req = toNeutral(body, provider);
        try {
          return toMessage(await backend.call(req, mode, options?.signal ?? undefined), req);
        } catch (e) {
          if (isAbort(e, options?.signal ?? undefined)) throw e;
          throw toCallError(e);
        }
      },
      stream(body, options) {
        const req = toNeutral(body, provider);
        const signal = options?.signal ?? undefined;
        let text = "";
        let resolveFinal!: (m: Anthropic.Message) => void;
        let rejectFinal!: (e: unknown) => void;
        const final = new Promise<Anthropic.Message>((res, rej) => { resolveFinal = res; rejectFinal = rej; });
        final.catch(() => {});
        return {
          async *[Symbol.asyncIterator]() {
            try {
              const it = backend.stream(req, signal);
              for (;;) {
                const n = await it.next();
                if (n.done) {
                  resolveFinal(toMessage({ text, stop: n.value.stop ?? "end", usage: { input: n.value.input, output: n.value.output } }, { ...req, tool: null }));
                  return;
                }
                text += n.value;
                yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: n.value } } as Anthropic.MessageStreamEvent;
              }
            } catch (e) {
              const err = isAbort(e, signal) ? e : toCallError(e);
              rejectFinal(err);
              throw err;
            }
          },
          finalMessage: () => final,
        };
      },
    },
  };
}

// ---------- OpenAI chat completions (OpenAI, Groq, DeepSeek, xAI, any compatible server) ----------

interface OaMessage { content?: string | null; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> | null; refusal?: string | null }
interface OaCompletion { choices: Array<{ message?: OaMessage; finish_reason?: string | null; delta?: { content?: string | null } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } | null }

/** The part of the OpenAI (and Groq) SDK used here. */
export interface OpenAiLike {
  chat: { completions: { create(body: Json, options?: { signal?: AbortSignal }): Promise<unknown> } };
}

const oaStop = (r: string | null | undefined): NeutralResult["stop"] => (r === "length" ? "length" : r === "content_filter" ? "refusal" : "end");

function parseArgs(a: unknown): unknown {
  if (a && typeof a === "object") return a;
  if (typeof a !== "string") return undefined;
  try { return JSON.parse(a); } catch { return undefined; }
}

export function openAiBackend(client: OpenAiLike, opts: { maxTokensField?: "max_tokens" | "max_completion_tokens"; streamUsage?: boolean } = {}): Backend {
  const maxField = opts.maxTokensField ?? "max_tokens";
  const base = (req: Neutral, mode: StructuredMode): Json => {
    const sys = req.tool && mode === "json_schema" ? jsonSystem(req.system, req.tool) : req.system;
    const body: Json = {
      model: req.model,
      messages: [...(sys ? [{ role: "system", content: sys }] : []), ...req.messages],
      [maxField]: req.maxTokens,
    };
    if (req.tool && mode === "json_schema") {
      body.response_format = { type: "json_schema", json_schema: { name: req.tool.name, schema: strictSchema(req.tool.input_schema as Json), strict: true } };
    } else if (req.tool) {
      body.tools = [{ type: "function", function: { name: req.tool.name, description: req.tool.description ?? "", parameters: req.tool.input_schema } }];
      body.tool_choice = { type: "function", function: { name: req.tool.name } };
    }
    return body;
  };
  return {
    async call(req, mode, signal) {
      const r = (await client.chat.completions.create(base(req, mode), signal ? { signal } : undefined)) as OaCompletion;
      const c = r.choices?.[0];
      const call = c?.message?.tool_calls?.find((t) => t.function?.name === req.tool?.name);
      const refused = !!c?.message?.refusal;
      return {
        text: c?.message?.content ?? "",
        toolInput: call ? parseArgs(call.function?.arguments) : undefined,
        stop: refused ? "refusal" : oaStop(c?.finish_reason),
        usage: { input: r.usage?.prompt_tokens ?? 0, output: r.usage?.completion_tokens ?? 0 },
      };
    },
    async *stream(req, signal) {
      const body = { ...base({ ...req, tool: null }, "tool"), stream: true, ...(opts.streamUsage ? { stream_options: { include_usage: true } } : {}) };
      const s = (await client.chat.completions.create(body, signal ? { signal } : undefined)) as AsyncIterable<OaCompletion>;
      const usage = { input: 0, output: 0, stop: "end" as NeutralResult["stop"] };
      for await (const ch of s) {
        const d = ch.choices?.[0]?.delta?.content;
        if (d) yield d;
        if (ch.choices?.[0]?.finish_reason) usage.stop = oaStop(ch.choices[0].finish_reason);
        if (ch.usage) { usage.input = ch.usage.prompt_tokens ?? 0; usage.output = ch.usage.completion_tokens ?? 0; }
      }
      return usage;
    },
  };
}

// ---------- Google Gemini (@google/genai) ----------

interface GemResponse {
  text?: string;
  candidates?: Array<{ finishReason?: string }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
}
export interface GeminiLike {
  models: {
    generateContent(p: Json): Promise<GemResponse>;
    generateContentStream(p: Json): Promise<AsyncIterable<GemResponse>>;
  };
}

const gemStop = (r?: string): NeutralResult["stop"] =>
  r === "MAX_TOKENS" ? "length" : r && /SAFETY|RECITATION|PROHIBITED|BLOCKLIST|SPII/.test(r) ? "refusal" : "end";
const gemUsage = (u: GemResponse["usageMetadata"]) => ({ input: u?.promptTokenCount ?? 0, output: (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0) });

/** Gemini always gets JSON-schema mode (responseJsonSchema) for structured output. */
export function geminiBackend(ai: GeminiLike): Backend {
  const params = (req: Neutral, signal?: AbortSignal): Json => {
    const config: Json = { maxOutputTokens: req.maxTokens, ...(signal ? { abortSignal: signal } : {}) };
    const sys = req.tool ? jsonSystem(req.system, req.tool) : req.system;
    if (sys) config.systemInstruction = sys;
    if (req.tool) {
      config.responseMimeType = "application/json";
      config.responseJsonSchema = withoutAdditional(req.tool.input_schema as Json);
    }
    return {
      model: req.model,
      contents: req.messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
      config,
    };
  };
  return {
    async call(req, _mode, signal) {
      const r = await ai.models.generateContent(params(req, signal));
      const text = r.text ?? "";
      return { text, toolInput: req.tool ? parseJsonObject(text) ?? undefined : undefined, stop: gemStop(r.candidates?.[0]?.finishReason), usage: gemUsage(r.usageMetadata) };
    },
    async *stream(req, signal) {
      const s = await ai.models.generateContentStream(params({ ...req, tool: null }, signal));
      let last: GemResponse | null = null;
      for await (const ch of s) {
        if (ch.text) yield ch.text;
        last = ch;
      }
      return { ...gemUsage(last?.usageMetadata), stop: gemStop(last?.candidates?.[0]?.finishReason) };
    },
  };
}

// ---------- Mistral and OpenRouter (their SDKs share a camelCase shape) ----------

interface CcMessage { content?: unknown; toolCalls?: Array<{ function?: { name?: string; arguments?: unknown } }> | null }
interface CcResult { choices?: Array<{ message?: CcMessage; finishReason?: string | null; delta?: { content?: unknown } }>; usage?: { promptTokens?: number; completionTokens?: number } | null }

export interface MistralLike {
  chat: {
    complete(req: Json, options?: Json): Promise<unknown>;
    stream(req: Json, options?: Json): Promise<AsyncIterable<{ data: CcResult }>>;
  };
}
export interface OpenRouterLike {
  chat: { send(req: Json, options?: Json): Promise<unknown> };
}

const ccText = (c: unknown): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => (x && typeof x === "object" && typeof (x as { text?: unknown }).text === "string" ? (x as { text: string }).text : "")).join("") : "";
const ccStop = (r?: string | null): NeutralResult["stop"] => (r === "length" || r === "model_length" ? "length" : r === "content_filter" ? "refusal" : "end");

function camelBody(req: Neutral, mode: StructuredMode, schemaKey: "schemaDefinition" | "schema"): Json {
  const sys = req.tool && mode === "json_schema" ? jsonSystem(req.system, req.tool) : req.system;
  const body: Json = { model: req.model, messages: [...(sys ? [{ role: "system", content: sys }] : []), ...req.messages], maxTokens: req.maxTokens };
  if (req.tool && mode === "json_schema") {
    body.responseFormat = { type: "json_schema", jsonSchema: { name: req.tool.name, [schemaKey]: strictSchema(req.tool.input_schema as Json), strict: true } };
  } else if (req.tool) {
    body.tools = [{ type: "function", function: { name: req.tool.name, description: req.tool.description ?? "", parameters: req.tool.input_schema } }];
    body.toolChoice = { type: "function", function: { name: req.tool.name } };
  }
  return body;
}

function ccResult(r: CcResult, req: Neutral): NeutralResult {
  const c = r.choices?.[0];
  const call = c?.message?.toolCalls?.find((t) => t.function?.name === req.tool?.name);
  return {
    text: ccText(c?.message?.content),
    toolInput: call ? parseArgs(call.function?.arguments) : undefined,
    stop: ccStop(c?.finishReason),
    usage: { input: r.usage?.promptTokens ?? 0, output: r.usage?.completionTokens ?? 0 },
  };
}

async function* ccStream(s: AsyncIterable<unknown>, unwrap: (e: unknown) => CcResult) {
  const usage = { input: 0, output: 0, stop: "end" as NeutralResult["stop"] };
  for await (const ev of s) {
    const ch = unwrap(ev);
    const d = ccText(ch.choices?.[0]?.delta?.content);
    if (d) yield d;
    if (ch.choices?.[0]?.finishReason) usage.stop = ccStop(ch.choices[0].finishReason);
    if (ch.usage) { usage.input = ch.usage.promptTokens ?? 0; usage.output = ch.usage.completionTokens ?? 0; }
  }
  return usage;
}

export function mistralBackend(client: MistralLike): Backend {
  const opts = (signal?: AbortSignal) => (signal ? { fetchOptions: { signal } } : undefined);
  return {
    async call(req, mode, signal) {
      return ccResult((await client.chat.complete(camelBody(req, mode, "schemaDefinition"), opts(signal))) as CcResult, req);
    },
    async *stream(req, signal) {
      const s = await client.chat.stream(camelBody({ ...req, tool: null }, "tool", "schemaDefinition"), opts(signal));
      return yield* ccStream(s, (e) => (e as { data: CcResult }).data ?? {});
    },
  };
}

export function openRouterBackend(client: OpenRouterLike): Backend {
  const opts = (signal?: AbortSignal) => (signal ? { fetchOptions: { signal } } : undefined);
  return {
    async call(req, mode, signal) {
      const r = await client.chat.send({ chatRequest: { ...camelBody(req, mode, "schema"), stream: false } }, opts(signal));
      return ccResult(r as CcResult, req);
    },
    async *stream(req, signal) {
      const s = (await client.chat.send({ chatRequest: { ...camelBody({ ...req, tool: null }, "tool", "schema"), stream: true } }, opts(signal))) as AsyncIterable<unknown>;
      return yield* ccStream(s, (e) => ((e as { data?: CcResult }).data ?? (e as CcResult)));
    },
  };
}

// ---------- Ollama (plain fetch against its REST API) ----------

export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string>; body?: ReadableStream<Uint8Array> | null }>;

interface OllamaChat { message?: { content?: string }; done?: boolean; done_reason?: string; prompt_eval_count?: number; eval_count?: number }

export function ollamaBackend(url: string, doFetch: FetchFn = fetch as unknown as FetchFn, numCtx = 32_768): Backend {
  const post = async (body: Json, signal?: AbortSignal) => {
    const res = await doFetch(`${url.replace(/\/+$/, "")}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
    if (!res.ok) throw Object.assign(new Error(`Ollama answered HTTP ${res.status}`), { status: res.status });
    return res;
  };
  const msgs = (req: Neutral, sys: string) => [...(sys ? [{ role: "system", content: sys }] : []), ...req.messages];
  return {
    async call(req, _mode, signal) {
      const sys = req.tool ? jsonSystem(req.system, req.tool) : req.system;
      const res = await post({ model: req.model, stream: false, messages: msgs(req, sys), options: { num_ctx: numCtx }, ...(req.tool ? { format: req.tool.input_schema } : {}) }, signal);
      const d = (await res.json()) as OllamaChat;
      const text = d.message?.content ?? "";
      return { text, toolInput: req.tool ? parseJsonObject(text) ?? undefined : undefined, stop: d.done_reason === "length" ? "length" : "end", usage: { input: d.prompt_eval_count ?? 0, output: d.eval_count ?? 0 } };
    },
    async *stream(req, signal) {
      const res = await post({ model: req.model, stream: true, messages: msgs(req, req.system), options: { num_ctx: numCtx } }, signal);
      const usage = { input: 0, output: 0, stop: "end" as NeutralResult["stop"] };
      const take = (line: string) => {
        if (!line.trim()) return "";
        const d = JSON.parse(line) as OllamaChat;
        if (d.done) { usage.input = d.prompt_eval_count ?? 0; usage.output = d.eval_count ?? 0; if (d.done_reason === "length") usage.stop = "length"; }
        return d.message?.content ?? "";
      };
      if (!res.body) {
        for (const l of (await res.text()).split("\n")) { const t = take(l); if (t) yield t; }
        return usage;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const t = take(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          if (t) yield t;
        }
      }
      const t = take(buf);
      if (t) yield t;
      return usage;
    },
  };
}
