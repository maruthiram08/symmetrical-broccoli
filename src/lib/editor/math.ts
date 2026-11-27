// LaTeX in the live preview, drawn with KaTeX. KaTeX is loaded the first time a note with math
// opens (never with the page); after that each formula draws synchronously, from a cache.
type Katex = typeof import("katex")["default"];

let katex: Katex | null = null;
let loading: Promise<Katex> | null = null;
const cache = new Map<string, MathResult>();
const MAX_CACHE = 400;

export type MathResult = { ok: true; html: string } | { ok: false; error: string };

export function loadKatex(): Promise<Katex> {
  if (katex) return Promise.resolve(katex);
  if (!loading) {
    loading = import("katex").then((m) => (katex = m.default));
    loading.catch(() => { loading = null; });
  }
  return loading;
}

/** The formula drawn, or why it can't be; null until KaTeX has loaded (call loadKatex). */
export function renderMathSync(tex: string, display: boolean): MathResult | null {
  const key = `${display ? "D" : "I"}${tex}`;
  const hit = cache.get(key);
  if (hit) return hit;
  if (!katex) return null;
  let r: MathResult;
  try {
    r = { ok: true, html: katex.renderToString(tex, { displayMode: display, throwOnError: true, strict: "ignore", trust: false, output: "htmlAndMathml", maxExpand: 500, maxSize: 50 }) };
  } catch (e) {
    r = { ok: false, error: (e instanceof Error ? e.message : String(e)).replace(/^KaTeX parse error:\s*/, "").split("\n")[0].slice(0, 200) };
  }
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value as string);
  cache.set(key, r);
  return r;
}
