// Local search for Ask: BM25 over items, meeting summaries, transcript chunks and notes, optionally
// fused with embedding similarity (reciprocal rank fusion). Pure and synchronous: no network here.
// The server (src/server/ask-index.ts) gathers the documents and, when you turned them on, the vectors.

export type DocType = "item" | "meeting" | "transcript" | "note";

export interface Doc {
  id: string;
  type: DocType;
  title: string;
  text: string;
  /** ISO time of the meeting or the note, for recency ties and the source line. */
  at: string | null;
  href: string;
  itemId?: string;
  meetingId?: string;
}

const STOP = new Set(
  ("a an the and or but if of to in on at by for from with about as is are was were be been being do does did " +
    "i me my we us our you your he she they them their it its this that these those there here what which who whom " +
    "when where why how any all some can could should would will shall may might must have has had get got " +
    "tell show give list find say said know let lets please just so than then not no yes up out into very really " +
    "hai ka ki ke ko se ho tha thi na bhi toh to hi")
    .split(" "),
);

/** Lower-case word stems, stopwords dropped. Unicode letters, marks and digits (Hinglish and Hindi work). */
export function tokenize(s: string): string[] {
  const out: string[] = [];
  for (const raw of s.toLowerCase().normalize("NFKC").split(/[^\p{L}\p{M}\p{N}]+/u)) {
    if (raw.length < 2 || STOP.has(raw)) continue;
    out.push(stem(raw));
  }
  return out;
}

/** A light English stemmer: enough that "decided", "deciding" and "decides" meet. */
export function stem(w: string): string {
  if (w.length <= 4 || !/^[a-z]+$/.test(w)) return w;
  for (const [suf, min] of [["ingly", 4], ["ings", 4], ["ing", 4], ["edly", 4], ["ies", 3], ["ied", 3], ["ed", 4], ["es", 4], ["ly", 4], ["s", 4]] as const) {
    if (w.endsWith(suf) && w.length - suf.length >= min) {
      const base = w.slice(0, -suf.length);
      if (suf === "ies" || suf === "ied") return base + "y";
      if (suf === "s" && base.endsWith("s")) return w;
      return base.replace(/(.)\1$/, "$1").replace(/e$/, "");
    }
  }
  return w.replace(/e$/, "");
}

export interface Hit { doc: Doc; score: number }

/** Okapi BM25 (k1 1.2, b 0.75) over the title and text of each document. */
export class Bm25 {
  private readonly tf: Array<Map<string, number>> = [];
  private readonly len: number[] = [];
  private readonly df = new Map<string, number>();
  private readonly avg: number;

  constructor(readonly docs: Doc[], private readonly k1 = 1.2, private readonly b = 0.75) {
    for (const d of docs) {
      const toks = tokenize(`${d.title} ${d.title} ${d.text}`);
      const m = new Map<string, number>();
      for (const t of toks) m.set(t, (m.get(t) ?? 0) + 1);
      this.tf.push(m);
      this.len.push(toks.length);
      for (const t of m.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    }
    this.avg = this.len.reduce((a, b) => a + b, 0) / Math.max(1, docs.length) || 1;
  }

  search(query: string, limit = 50): Hit[] {
    const q = [...new Set(tokenize(query))];
    if (!q.length) return [];
    const N = this.docs.length;
    const out: Hit[] = [];
    for (let i = 0; i < N; i++) {
      let s = 0;
      const tf = this.tf[i];
      for (const t of q) {
        const f = tf.get(t);
        if (!f) continue;
        const n = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        s += idf * ((f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * this.len[i]) / this.avg)));
      }
      if (s > 0) out.push({ doc: this.docs[i], score: s });
    }
    return out.sort((a, b) => b.score - a.score || (b.doc.at ?? "").localeCompare(a.doc.at ?? "")).slice(0, limit);
  }
}

/**
 * Splits long text (a transcript, a note) into overlapping chunks of about `size` characters, cut
 * at line ends where it can, so a speaker's turn stays whole.
 */
export function chunkText(text: string, size = 900, overlap = 150): string[] {
  const t = text.replace(/\r\n/g, "\n").trim();
  if (t.length <= size) return t ? [t] : [];
  const out: string[] = [];
  let start = 0;
  while (start < t.length) {
    let end = Math.min(t.length, start + size);
    if (end < t.length) {
      const nl = t.lastIndexOf("\n", end);
      const sp = t.lastIndexOf(" ", end);
      const cut = nl > start + size / 2 ? nl : sp > start + size / 2 ? sp : end;
      end = cut;
    }
    out.push(t.slice(start, end).trim());
    if (end >= t.length) break;
    let next = Math.max(end - overlap, start + 1);
    const sp = t.indexOf(" ", next);
    if (sp > 0 && sp < end) next = sp + 1;
    start = next;
  }
  return out.filter(Boolean);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Nearest documents to a query vector. */
export function vectorSearch(docs: Doc[], vectors: Map<string, number[]>, query: number[], limit = 50, min = 0.2): Hit[] {
  const out: Hit[] = [];
  for (const d of docs) {
    const v = vectors.get(d.id);
    if (!v) continue;
    const s = cosine(query, v);
    if (s >= min) out.push({ doc: d, score: s });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Reciprocal rank fusion of ranked lists (k = 60): documents high on either list come first. */
export function fuse(lists: Hit[][], k = 60): Hit[] {
  const score = new Map<string, { doc: Doc; s: number }>();
  for (const list of lists) {
    list.forEach((h, rank) => {
      const cur = score.get(h.doc.id) ?? { doc: h.doc, s: 0 };
      cur.s += 1 / (k + rank + 1);
      score.set(h.doc.id, cur);
    });
  }
  return [...score.values()].sort((a, b) => b.s - a.s).map((x) => ({ doc: x.doc, score: x.s }));
}

/** Text that goes into an embedding for a document. */
export const embedText = (d: Doc) => `${d.title}\n${d.text}`.slice(0, 2000);
