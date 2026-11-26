// Side-by-side extraction: the same meeting read by 2-3 provider/model pairs, lined up so the
// differences show. Pure: estimates before running, and the diff after.
import { approxTokens } from "./common";
import { inrFor, TYPICAL, type Price } from "./estimate";
import { splitModel } from "./providers";
import { SYSTEM_PROMPT, buildUserMessage } from "../extract/prompt";
import { normalize } from "../extract/extract";
import type { ExtractionInput, ExtractionResult, ItemKind } from "../types";

export const COMPARE_MIN = 2;
export const COMPARE_MAX = 3;

export interface PairEstimate {
  qualified: string;
  inputTokens: number;
  outputTokens: number;
  /** Rupees, 0 for local and plan models, null when the price isn't known. */
  costInr: number | null;
  note: "free" | "plan" | "unknown" | null;
}

/** What each pair would cost for this meeting. Output assumed typical (1.6k tokens). */
export function estimatePairs(input: ExtractionInput, pairs: string[], prices: (qualified: string) => Price | null): PairEstimate[] {
  const inputTokens = approxTokens(SYSTEM_PROMPT.length + buildUserMessage(input).length) + 600; // + tool schema
  const outputTokens = TYPICAL.extraction.output;
  return pairs.map((q) => {
    const { provider } = splitModel(q);
    if (provider === "ollama") return { qualified: q, inputTokens, outputTokens, costInr: 0, note: "free" };
    if (provider === "claude-plan") return { qualified: q, inputTokens, outputTokens, costInr: 0, note: "plan" };
    const p = prices(q);
    return { qualified: q, inputTokens, outputTokens, costInr: p ? inrFor(p, { input: inputTokens, output: outputTokens }) : null, note: p ? null : "unknown" };
  });
}

/** Sum of the known estimates, and whether some are unknown. */
export function totalEstimate(es: PairEstimate[]): { costInr: number; unknown: number } {
  return { costInr: es.reduce((a, e) => a + (e.costInr ?? 0), 0), unknown: es.filter((e) => e.costInr === null).length };
}

export type NewItem = ExtractionResult["newItems"][number];

export interface DiffRow {
  kind: ItemKind;
  /** One cell per pair: what that pair found, or null. */
  cells: Array<NewItem | null>;
  /** Found by every pair that ran. */
  agreed: boolean;
}

const WORDS_STOP = new Set("a an the to of for and or in on at by with from as is are be it this that".split(" "));
function words(s: string): Set<string> {
  return new Set(normalize(s).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 && !WORDS_STOP.has(w)));
}

/** Two items are the same find: same kind, and the same quote or most of the same words. */
export function sameFind(a: NewItem, b: NewItem): boolean {
  if (a.kind !== b.kind) return false;
  const qa = normalize(a.quote), qb = normalize(b.quote);
  if (qa && qb && (qa.includes(qb) || qb.includes(qa))) return true;
  const A = words(a.text), B = words(b.text);
  if (!A.size || !B.size) return false;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return (2 * shared) / (A.size + B.size) >= 0.6;
}

/** Lines up the pairs' items: one row per distinct find, kinds in owe / waiting / decision order. */
export function diffItems(results: Array<NewItem[] | null>): DiffRow[] {
  const rows: DiffRow[] = [];
  results.forEach((items, col) => {
    for (const it of items ?? []) {
      const row = rows.find((r) => r.kind === it.kind && !r.cells[col] && r.cells.some((c) => c && sameFind(c, it)));
      if (row) row.cells[col] = it;
      else {
        const cells: Array<NewItem | null> = results.map(() => null);
        cells[col] = it;
        rows.push({ kind: it.kind, cells, agreed: false });
      }
    }
  });
  const ran = results.map((r) => r !== null);
  for (const r of rows) r.agreed = r.cells.every((c, i) => !ran[i] || c !== null);
  const order: Record<ItemKind, number> = { owe: 0, waiting: 1, decision: 2 };
  return rows.sort((a, b) => order[a.kind] - order[b.kind] || Number(b.agreed) - Number(a.agreed));
}

/** Closes per open item id: which pairs closed it. */
export function diffCloses(results: Array<ExtractionResult["closes"] | null>): Array<{ itemId: string; by: boolean[] }> {
  const ids = [...new Set(results.flatMap((r) => (r ?? []).map((c) => c.itemId)))];
  return ids.map((itemId) => ({ itemId, by: results.map((r) => !!r?.some((c) => c.itemId === itemId)) }));
}
