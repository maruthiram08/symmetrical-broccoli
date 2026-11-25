import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ensureFreshAccessToken, WisprOAuthProvider, type RefreshFn, type WisprAuthContext } from "./oauth";

export interface WisprMeeting {
  providerMeetingId: string;
  title: string;
  startedAt: string; // ISO UTC, ms precision
  participants: string[];
  /** false while Wispr Flow is still recording/finalizing. Poll does not queue these yet. */
  finalized: boolean;
  hasTranscript: boolean;
}

export interface WisprClient {
  /** Meetings that started at or after sinceIso, oldest first. */
  listMeetingsSince(sinceIso: string): Promise<WisprMeeting[]>;
  /** Full plaintext transcript ("" when there is none). Never store or log it. */
  getTranscript(providerMeetingId: string): Promise<string>;
  close?(): Promise<void>;
}

/**
 * Every Wispr Flow tool name and argument lives here.
 *
 * TODO(day 2): verify on day 2 against tools/list on the production server (WISPR_MCP_URL).
 * Names/args below were read from the tool schemas the Wispr Flow connector exposed to Claude on
 * 2026-11-25 (search_meetings: since/until/sort/limit; get_meeting: meeting_id/view_transcript),
 * plus one live response of each. Same vendor, but confirm it is the same server and version.
 */
export const WISPR_TOOLS = {
  searchMeetings: {
    name: "search_meetings",
    /** sort:"start" = meetings that have begun, newest first, single page (no cursor), max 200. */
    pageSize: 200,
    args: (sinceIso: string, untilIso?: string) => ({
      since: sinceIso,
      ...(untilIso ? { until: untilIso } : {}),
      sort: "start",
      limit: 200,
    }),
  },
  getMeeting: {
    name: "get_meeting",
    /** Server max char_limit is 40000; longer transcripts come back truncated with a continuation offset. */
    args: (providerMeetingId: string, startChar: number) => ({
      meeting_id: providerMeetingId,
      view_transcript: { start_char: startChar, char_limit: 40000 },
      view_content: { char_limit: 1 }, // we never use the notes body
    }),
  },
  /** Results with shared=true are someone else's notes. OPEN QUESTION: include them? Off for sprint 1. */
  includeShared: false,
  /** A meeting still unfinalized after this long is queued anyway so it can't block lastSeenAt forever. */
  unfinalizedGiveUpMs: 24 * 60 * 60 * 1000,
} as const;

// ---------- defensive parsing ----------

const AttendeeSchema = z.union([
  z.string(),
  z.object({ name: z.string().nullish(), display_name: z.string().nullish(), email: z.string().nullish() }).passthrough(),
]);

const MeetingSchema = z
  .object({
    id: z.union([z.string(), z.number()]).transform(String),
    title: z.string().nullish(),
    start: z.string().nullish(),
    start_time: z.string().nullish(),
    started_at: z.string().nullish(),
    created_at: z.string().nullish(),
    attendees: z.array(z.unknown()).nullish(),
    participants: z.array(z.unknown()).nullish(),
    finalized: z.boolean().nullish(),
    has_transcript: z.boolean().nullish(),
    shared: z.boolean().nullish(),
  })
  .passthrough();

const SearchResultSchema = z
  .object({
    meetings: z.array(z.unknown()).optional(),
    results: z.array(z.unknown()).optional(),
    items: z.array(z.unknown()).optional(),
  })
  .passthrough();

const GetMeetingSchema = z.object({ transcript: z.string().nullish() }).passthrough();

const ToolResultSchema = z
  .object({
    isError: z.boolean().optional(),
    structuredContent: z.unknown().optional(),
    content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()).optional(),
  })
  .passthrough();

/** MCP tool result → JSON payload (structuredContent, else the first JSON text block). */
export function toolPayload(raw: unknown, toolName: string): unknown {
  const r = ToolResultSchema.parse(raw);
  const text = (r.content ?? []).filter((c) => c.type === "text" && typeof c.text === "string").map((c) => c.text!).join("");
  if (r.isError) throw new Error(`Wispr Flow ${toolName} returned an error: ${text.slice(0, 200)}`);
  if (r.structuredContent && typeof r.structuredContent === "object") return r.structuredContent;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Wispr Flow ${toolName} returned non-JSON content`);
  }
}

function participantName(a: unknown): string | null {
  const p = AttendeeSchema.safeParse(a);
  if (!p.success) return null;
  if (typeof p.data === "string") return p.data.trim() || null;
  return (p.data.name ?? p.data.display_name ?? p.data.email ?? "").trim() || null;
}

function toIso(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export function parseMeetings(payload: unknown): Array<WisprMeeting & { shared: boolean }> {
  const r = SearchResultSchema.parse(payload);
  const list = r.meetings ?? r.results ?? r.items ?? [];
  const out: Array<WisprMeeting & { shared: boolean }> = [];
  for (const raw of list) {
    const m = MeetingSchema.safeParse(raw);
    if (!m.success) continue;
    const startedAt = toIso(m.data.start ?? m.data.start_time ?? m.data.started_at ?? m.data.created_at);
    if (!startedAt) continue;
    const people = (m.data.attendees ?? m.data.participants ?? []).map(participantName).filter((x): x is string => !!x);
    out.push({
      providerMeetingId: m.data.id,
      title: m.data.title?.trim() || "Untitled meeting",
      startedAt,
      participants: [...new Set(people)],
      finalized: m.data.finalized !== false,
      hasTranscript: m.data.has_transcript !== false,
      shared: m.data.shared === true,
    });
  }
  return out;
}

const TRUNCATION = /(?:\n\n)?\(\.\.\.truncated, \d+ chars remaining; continue with view_transcript\.start_char=(\d+)\.\.\.\)\s*$/;
const GUARD_HEADER = /^<<<[^\n]*>>>\n?/;
const END_MARKER = /\n?<<<END TRANSCRIPT>>>\s*$/;

/**
 * One transcript page -> { text, next }. Wispr wraps each page as
 *   "<<<PARTICIPANT NAMES ... >>>\n" + text + "\n\n(...truncated, N chars remaining; continue with view_transcript.start_char=X...)" + "\n<<<END TRANSCRIPT>>>"
 * (observed 2026-11-25). Only those wrappers are removed so pages join back exactly.
 */
export function parseTranscriptPage(payload: unknown): { text: string; next: number | null } {
  let raw = GetMeetingSchema.parse(payload).transcript ?? "";
  raw = raw.replace(GUARD_HEADER, "").replace(END_MARKER, "");
  const m = raw.match(TRUNCATION);
  if (m) raw = raw.slice(0, m.index);
  return { text: raw, next: m ? Number(m[1]) : null };
}

// ---------- the client ----------

export interface ToolCaller {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export async function connectMcp(ctx: WisprAuthContext): Promise<ToolCaller> {
  const transport = new StreamableHTTPClientTransport(new URL(ctx.serverUrl), {
    authProvider: new WisprOAuthProvider(ctx, "background"),
    fetch: ctx.fetchFn,
  });
  const client = new Client({ name: "daily-brief", version: "0.1.0" });
  await client.connect(transport);
  return {
    callTool: (name, args) => client.callTool({ name, arguments: args }),
    close: () => client.close(),
  };
}

const MAX_SEARCH_PAGES = 20;
const MAX_TRANSCRIPT_PAGES = 50; // 2M chars

export class McpWisprClient implements WisprClient {
  private caller: Promise<ToolCaller> | null = null;

  constructor(
    private ctx: WisprAuthContext,
    private opts: { connect?: (ctx: WisprAuthContext) => Promise<ToolCaller>; refresh?: RefreshFn } = {},
  ) {}

  private async tools(): Promise<ToolCaller> {
    this.caller ??= (async () => {
      await ensureFreshAccessToken(this.ctx, { refresh: this.opts.refresh });
      return (this.opts.connect ?? connectMcp)(this.ctx);
    })();
    try {
      return await this.caller;
    } catch (e) {
      this.caller = null;
      throw e;
    }
  }

  async listMeetingsSince(sinceIso: string): Promise<WisprMeeting[]> {
    const tools = await this.tools();
    const t = WISPR_TOOLS.searchMeetings;
    const seen = new Map<string, WisprMeeting>();
    let until: string | undefined;
    for (let page = 0; page < MAX_SEARCH_PAGES; page++) {
      const batch = parseMeetings(toolPayload(await tools.callTool(t.name, t.args(sinceIso, until)), t.name));
      for (const m of batch) {
        if (m.startedAt < sinceIso) continue;
        if (m.shared && !WISPR_TOOLS.includeShared) continue;
        seen.set(m.providerMeetingId, {
          providerMeetingId: m.providerMeetingId, title: m.title, startedAt: m.startedAt,
          participants: m.participants, finalized: m.finalized, hasTranscript: m.hasTranscript,
        });
      }
      // sort:"start" has no cursor: a full page means there may be older ones; narrow `until`.
      if (batch.length < t.pageSize) break;
      const oldest = batch.reduce((a, b) => (a.startedAt < b.startedAt ? a : b)).startedAt;
      if (until && oldest >= until) break; // no progress
      until = oldest;
    }
    return [...seen.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  async getTranscript(providerMeetingId: string): Promise<string> {
    const tools = await this.tools();
    const t = WISPR_TOOLS.getMeeting;
    const parts: string[] = [];
    let start = 0;
    for (let page = 0; page < MAX_TRANSCRIPT_PAGES; page++) {
      const { text, next } = parseTranscriptPage(toolPayload(await tools.callTool(t.name, t.args(providerMeetingId, start)), t.name));
      parts.push(text);
      if (next === null || next <= start) break;
      start = next;
    }
    return parts.join("");
  }

  async close(): Promise<void> {
    const c = this.caller;
    this.caller = null;
    if (c) await c.then((x) => x.close()).catch(() => undefined);
  }
}
