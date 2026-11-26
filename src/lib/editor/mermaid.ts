// Mermaid diagrams in notes: a ```mermaid block is drawn in the live preview. Mermaid is large,
// so it is loaded the first time a note with a diagram opens, never with the page.
type Mermaid = (typeof import("mermaid"))["default"];

let loading: Promise<Mermaid> | null = null;
let seq = 0;
const cache = new Map<string, string>();
const MAX_CACHE = 50;

function isDark(): boolean {
  try {
    const t = document.documentElement.dataset.theme;
    if (t === "dark") return true;
    if (t === "light") return false;
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch { return false; }
}

function load(): Promise<Mermaid> {
  if (!loading) {
    loading = import("mermaid").then((m) => {
      m.default.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: isDark() ? "dark" : "neutral",
        fontFamily: "var(--font-sans), system-ui, sans-serif",
      });
      return m.default;
    });
    loading.catch(() => { loading = null; });
  }
  return loading;
}

/** The SVG drawn before for this exact code, if any. */
export function mermaidCached(code: string): string | null {
  return cache.get(code) ?? null;
}

/** Draw a diagram to SVG (sanitised by Mermaid's strict mode). Throws on a syntax error. */
export async function renderMermaid(code: string): Promise<string> {
  const hit = cache.get(code);
  if (hit) return hit;
  const m = await load();
  const id = `db-mermaid-${++seq}`;
  try {
    const { svg } = await m.render(id, code);
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value as string);
    cache.set(code, svg);
    return svg;
  } finally {
    // A failed render leaves its scratch element behind.
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
  }
}
