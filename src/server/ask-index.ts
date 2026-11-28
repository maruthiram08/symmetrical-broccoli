// Ask's local search on this computer: builds the documents (items, meeting summaries, transcript
// chunks from local recorder files, notes and day notes), ranks them with BM25 and, when turned on,
// embeddings from a local Ollama model (or, with "Search on this Mac only" off, an OpenAI-compatible
// provider). With nothing installed it is BM25 alone and makes no network call at all.
//
// Transcripts are read from their files and kept only in memory, never written anywhere. Embedding
// vectors of items, meetings and notes are cached in <workspace>/.daily-brief/ask-embeddings.json.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { localDate } from "@/lib/brief/time";
import { splitNotes } from "@/lib/capture/notes";
import { Bm25, chunkText, embedText, fuse, vectorSearch, type Doc, type Hit } from "@/lib/ask/local-index";
import { fitSources } from "@/lib/ask/prompt";
import { kindHints, MAX_SOURCES, type ItemSource, type PassageSource, type Source } from "@/lib/ask/retrieve";
import { providerOf, type Item, type Meeting, type User } from "@/lib/types";
import { aiPrefs, readKey, baseUrlOf, type AiPrefs } from "@/server/ai-config";
import { getStore } from "@/server/local/app";
import { readJson, writeJson } from "@/server/local/json-file";
import { listPages, readPage } from "@/server/local/pages";
import { dataDir, notesDir } from "@/server/local/paths";
import { localTranscript } from "@/server/recorders";
import OpenAI from "openai";

/** Passages (non-item sources) sent with one question at most. */
export const MAX_PASSAGES = 12;
const KIND = { owe: "You owe", waiting: "Waiting on", decision: "Decision" } as const;

export interface IndexInput {
  user: User;
  items: Item[];
  meetings: Meeting[];
  pages: Array<{ slug: string; title: string; markdown: string; updatedAt: string }>;
  dayNotes: Array<{ date: string; notes: string }>;
  transcripts: Map<string, string>;
}

/** The documents of the index, from already-loaded data. Pure. */
export function buildDocs(x: IndexInput): Doc[] {
  const tz = x.user.timeZone;
  const byId = new Map(x.meetings.map((m) => [m.id, m]));
  const docs: Doc[] = [];
  for (const i of x.items) {
    if (i.status === "wrong") continue;
    const m = byId.get(i.meetingId);
    docs.push({
      id: `item:${i.id}`, type: "item", title: i.text, itemId: i.id, meetingId: i.meetingId,
      text: [KIND[i.kind], i.person ?? "", i.quote, i.closeQuote ?? "", i.note ?? "", m?.title ?? ""].filter(Boolean).join(" · "),
      at: m?.startedAt ?? i.createdAt, href: `/item/${encodeURIComponent(i.id)}`,
    });
  }
  for (const m of x.meetings) {
    if (m.duplicateOf) continue;
    const its = x.items.filter((i) => i.meetingId === m.id && i.status !== "wrong");
    const day = localDate(new Date(m.startedAt), tz);
    docs.push({
      id: `meeting:${m.id}`, type: "meeting", title: m.title, meetingId: m.id, at: m.startedAt, href: `/day/${day}`,
      text: [`${day}. With ${m.participants.join(", ") || "no one listed"}.`, ...its.map((i) => `${KIND[i.kind]}: ${i.text}${i.person ? ` (${i.person})` : ""}.`)].join("\n"),
    });
    const t = x.transcripts.get(m.id);
    if (t) {
      chunkText(t).forEach((c, k) => docs.push({ id: `transcript:${m.id}:${k}`, type: "transcript", title: m.title, meetingId: m.id, at: m.startedAt, href: `/day/${day}`, text: c }));
    }
  }
  for (const p of x.pages) {
    chunkText(p.markdown, 1200, 150).forEach((c, k) => docs.push({ id: `note:${p.slug}:${k}`, type: "note", title: p.title, at: p.updatedAt, href: `/notes/${encodeURIComponent(p.slug)}`, text: c }));
  }
  for (const d of x.dayNotes) {
    chunkText(d.notes, 1200, 150).forEach((c, k) => docs.push({ id: `day:${d.date}:${k}`, type: "note", title: `Notes, ${d.date}`, at: `${d.date}T12:00:00.000Z`, href: `/day/${d.date}`, text: c }));
  }
  return docs;
}

function toSource(h: Hit, items: Map<string, Item>, meetings: Map<string, Meeting>, n: number): Source | null {
  const d = h.doc;
  if (d.type === "item") {
    const i = items.get(d.itemId!);
    if (!i) return null;
    const m = meetings.get(i.meetingId);
    const s: ItemSource = {
      n, itemId: i.id, kind: i.kind, status: i.status, text: i.text, person: i.person, quote: i.quote, closeQuote: i.closeQuote, dueAt: i.dueAt,
      meetingTitle: m?.title ?? "a meeting", at: m?.startedAt ?? i.createdAt, href: d.href,
    };
    return s;
  }
  const p: PassageSource = { n, type: d.type, docId: d.id, title: d.title, text: d.text, at: d.at, href: d.href, ...(d.meetingId ? { meetingId: d.meetingId } : {}) };
  return p;
}

/**
 * The sources for one question: fused BM25 (and vector) hits, at most MAX_PASSAGES passages, then
 * (when the question asks about owe / waiting / decisions / overdue) the newest such open items, as
 * the item search always did. Numbered from 1 and cut to fit the context budget. Pure.
 */
export function rankSources(q: { question: string; extra?: string }, docs: Doc[], items: Item[], meetings: Meeting[], now: Date, tz: string, vector?: Hit[]): Source[] {
  const bm = new Bm25(docs).search(`${q.question} ${q.extra ?? ""}`, 80);
  const ranked = vector?.length ? fuse([bm, vector]) : bm;
  const itemById = new Map(items.map((i) => [i.id, i]));
  const meetingById = new Map(meetings.map((m) => [m.id, m]));
  const out: Source[] = [];
  const seenItems = new Set<string>();
  let passages = 0;
  for (const h of ranked) {
    if (out.length >= MAX_SOURCES) break;
    if (h.doc.type === "item") {
      if (seenItems.has(h.doc.itemId!)) continue;
      seenItems.add(h.doc.itemId!);
    } else if (passages >= MAX_PASSAGES) continue;
    const s = toSource(h, itemById, meetingById, out.length + 1);
    if (!s) continue;
    if (s.type && s.type !== "item") passages++;
    out.push(s);
  }
  const { kinds, overdue } = kindHints(q.question);
  if (kinds.length) {
    const at = (i: Item) => meetingById.get(i.meetingId)?.startedAt ?? i.createdAt;
    const pool = items
      .filter((i) => kinds.includes(i.kind) && i.status === "open" && !seenItems.has(i.id))
      .filter((i) => !overdue || (i.dueAt !== null && Date.parse(i.dueAt) < now.getTime()))
      .sort((a, b) => at(b).localeCompare(at(a)));
    for (const i of pool) {
      if (out.length >= MAX_SOURCES) break;
      const s = toSource({ doc: { id: `item:${i.id}`, type: "item", itemId: i.id, title: i.text, text: "", at: null, href: `/item/${encodeURIComponent(i.id)}` }, score: 0 }, itemById, meetingById, out.length + 1);
      if (s) out.push(s);
    }
  }
  return fitSources(out, tz).map((s, k) => ({ ...s, n: k + 1 }));
}

// ---------- loading (server) ----------

const g = globalThis as unknown as { __dbTranscripts?: Map<string, { key: string; text: string }> };
const transcriptCache = () => (g.__dbTranscripts ??= new Map());

/** Transcripts of meetings from local recorder files, read on this computer, cached in memory by file mtime. */
async function localTranscripts(user: User, meetings: Meeting[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const m of meetings) {
    if (providerOf(m) === "wispr_flow" || m.duplicateOf) continue;
    let key = m.id;
    try { if (m.sourcePath && existsSync(m.sourcePath)) key += `:${statSync(m.sourcePath).mtimeMs}`; } catch { /* keep the id */ }
    const hit = transcriptCache().get(m.id);
    if (hit && hit.key === key) { out.set(m.id, hit.text); continue; }
    try {
      const text = await localTranscript(m, user);
      transcriptCache().set(m.id, { key, text });
      out.set(m.id, text);
    } catch { /* file gone: just not searchable */ }
  }
  return out;
}

function dayNotes(dir = notesDir()): IndexInput["dayNotes"] {
  if (!existsSync(dir)) return [];
  const out: IndexInput["dayNotes"] = [];
  for (const f of readdirSync(dir)) {
    const m = /^(\d{4}-\d{2}-\d{2})\.md$/.exec(f);
    if (!m) continue;
    try {
      const notes = splitNotes(readFileSync(join(dir, f), "utf8")).notes ?? "";
      if (notes.trim()) out.push({ date: m[1], notes });
    } catch { /* unreadable: skip */ }
  }
  return out;
}

export async function loadIndexInput(user: User): Promise<IndexInput> {
  const store = getStore();
  const [items, meetings] = await Promise.all([store.listItems(user.id), store.listMeetingsBetween(user.id, "0000", "9999")]);
  const pages = listPages().flatMap((p) => {
    const r = readPage(p.slug);
    return r ? [{ slug: p.slug, title: p.title, markdown: r.markdown, updatedAt: p.updatedAt }] : [];
  });
  return { user, items, meetings, pages, dayNotes: dayNotes(), transcripts: await localTranscripts(user, meetings) };
}

// ---------- embeddings (optional) ----------

export type Embedder = (texts: string[]) => Promise<number[][]>;

/** Ollama's /api/embed, on this computer. */
export function ollamaEmbedder(url: string, model: string, doFetch: typeof fetch = fetch): Embedder {
  return async (texts) => {
    const res = await doFetch(`${url.replace(/\/+$/, "")}/api/embed`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, input: texts }), signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw Object.assign(new Error(`Ollama embed HTTP ${res.status}`), { status: res.status });
    const d = (await res.json()) as { embeddings?: number[][] };
    if (!Array.isArray(d.embeddings) || d.embeddings.length !== texts.length) throw new Error("Ollama returned no embeddings");
    return d.embeddings;
  };
}

/** The embedder Settings allow: none, local Ollama, or (only with local-only off) an OpenAI-compatible API. */
export async function embedderFor(p: AiPrefs = aiPrefs()): Promise<{ embed: Embedder; model: string; where: "local" | "remote" } | null> {
  const s = p.search;
  if (s.embeddings === "off" || !s.embedModel.trim()) return null;
  if (s.embeddings === "ollama") return { embed: ollamaEmbedder(baseUrlOf("ollama", p)!, s.embedModel), model: `ollama:${s.embedModel}`, where: "local" };
  if (s.localOnly) return null; // "Search on this Mac only" never sends text out for embeddings
  const apiKey = await readKey(s.embedProvider);
  const baseURL = baseUrlOf(s.embedProvider, p) ?? undefined;
  if (s.embedProvider === "openai" && !apiKey) return null;
  if (s.embedProvider === "compatible" && !baseURL) return null;
  const client = new OpenAI({ apiKey: apiKey || "none", baseURL, maxRetries: 0, timeout: 60_000 });
  return {
    model: `${s.embedProvider}:${s.embedModel}`, where: "remote",
    embed: async (texts) => (await client.embeddings.create({ model: s.embedModel, input: texts })).data.map((d) => d.embedding),
  };
}

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 24);
const MAX_EMBED_PER_QUERY = 400;
const CACHE_MAX = 5000;

/** Vectors for the documents (cached; transcripts only in memory) and the query. Null on any failure. */
export async function vectorHits(docs: Doc[], query: string, e: { embed: Embedder; model: string }, path = join(dataDir(), "ask-embeddings.json")): Promise<Hit[] | null> {
  const mem = ((globalThis as unknown as { __dbVec?: Map<string, number[]> }).__dbVec ??= new Map());
  const disk = readJson<{ model?: string; vectors: Record<string, number[]> }>(path, { vectors: {} });
  const stored = disk.model === e.model ? disk.vectors : {};
  const keyOf = (d: Doc) => `${e.model}:${hash(embedText(d))}`;
  const vectors = new Map<string, number[]>();
  const missing: Doc[] = [];
  for (const d of docs) {
    const k = keyOf(d);
    const v = mem.get(k) ?? stored[k];
    if (v) vectors.set(d.id, v);
    else missing.push(d);
  }
  try {
    const todo = missing.slice(0, MAX_EMBED_PER_QUERY);
    let wrote = false;
    for (let i = 0; i < todo.length; i += 32) {
      const batch = todo.slice(i, i + 32);
      const vs = await e.embed(batch.map(embedText));
      batch.forEach((d, j) => {
        const v = vs[j].map((x) => Math.round(x * 1e4) / 1e4);
        vectors.set(d.id, v);
        mem.set(keyOf(d), v);
        if (d.type !== "transcript") { stored[keyOf(d)] = v; wrote = true; }
      });
    }
    if (wrote) {
      const keys = Object.keys(stored);
      const keep = keys.length > CACHE_MAX ? Object.fromEntries(keys.slice(-CACHE_MAX).map((k) => [k, stored[k]])) : stored;
      writeJson(path, { model: e.model, vectors: keep });
    }
    const [q] = await e.embed([query]);
    return vectorSearch(docs, vectors, q);
  } catch {
    return null; // BM25 alone
  }
}

export interface Retrieval {
  sources: Source[];
  /** How the passages were found, for the line under the answer. */
  how: "bm25" | "bm25+local-embeddings" | "bm25+remote-embeddings";
  docs: number;
}

/** Retrieval for Ask: entirely on this computer unless you turned "Search on this Mac only" off. */
export async function retrieveLocal(user: User, question: string, opts: { extra?: string; now?: Date; prefs?: AiPrefs } = {}): Promise<Retrieval> {
  const input = await loadIndexInput(user);
  const docs = buildDocs(input);
  const p = opts.prefs ?? aiPrefs();
  let vector: Hit[] | null = null;
  let how: Retrieval["how"] = "bm25";
  const e = await embedderFor(p).catch(() => null);
  if (e && docs.length) {
    vector = await vectorHits(docs, `${question} ${opts.extra ?? ""}`.trim(), e);
    if (vector) how = e.where === "local" ? "bm25+local-embeddings" : "bm25+remote-embeddings";
  }
  const sources = rankSources({ question, extra: opts.extra }, docs, input.items, input.meetings, opts.now ?? new Date(), user.timeZone, vector ?? undefined);
  return { sources, how, docs: docs.length };
}
