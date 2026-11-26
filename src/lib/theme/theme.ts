// Themes: a few editable tokens (accent, background, ink, font, density, radius), each with a
// light and a dark variant, turned into CSS variables and nothing else. The default theme is the
// app as designed and writes no CSS at all, so it stays exactly as it is.
// Pure; validation is strict because values end up in a stylesheet.

export const FONTS = {
  instrument: { label: "Instrument Sans", stack: 'var(--font-instrument-sans), -apple-system, "Segoe UI", system-ui, sans-serif' },
  system: { label: "System", stack: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif' },
  helvetica: { label: "Helvetica", stack: '"Helvetica Neue", Helvetica, Arial, sans-serif' },
  serif: { label: "Serif (Georgia)", stack: 'Charter, "Iowan Old Style", Georgia, "Times New Roman", serif' },
  mono: { label: "Geist Mono", stack: 'var(--font-geist-mono), ui-monospace, "SF Mono", Menlo, monospace' },
} as const;
export type FontId = keyof typeof FONTS;

export const DENSITIES = { compact: { label: "Compact", scale: 0.8 }, default: { label: "Default", scale: 1 }, roomy: { label: "Roomy", scale: 1.2 } } as const;
export type Density = keyof typeof DENSITIES;

export const RADII = { square: { label: "Square", scale: 0.25 }, default: { label: "Default", scale: 1 }, round: { label: "Round", scale: 1.6 } } as const;
export type Radius = keyof typeof RADII;

export interface Palette {
  /** The highlighter: You owe, the brand mark, switches. */
  accent: string;
  bg: string;
  ink: string;
}

export interface Theme {
  id: string;
  name: string;
  light: Palette;
  dark: Palette;
  font: FontId;
  density: Density;
  radius: Radius;
}

export const DEFAULT_ID = "default";

/** Today's design, token for token (globals.css). */
export const DEFAULT_THEME: Theme = {
  id: DEFAULT_ID,
  name: "Daily brief",
  light: { accent: "#d6ff3d", bg: "#ffffff", ink: "#0a0a0a" },
  dark: { accent: "#d6ff3d", bg: "#0b0b0c", ink: "#f4f4f5" },
  font: "instrument",
  density: "default",
  radius: "default",
};

export interface ThemeState {
  /** The theme in use; DEFAULT_ID (or a missing id) is the default. */
  active: string;
  /** Your own themes. The default is never stored. */
  themes: Theme[];
}

export const emptyThemeState = (): ThemeState => ({ active: DEFAULT_ID, themes: [] });

// ---------- colours ----------

const HEX = /^#[0-9a-f]{6}$/i;

/** "#ABC" or "abc123" -> "#aabbcc"/"#abc123"; null when it isn't a hex colour. */
export function normHex(v: unknown): string | null {
  if (typeof v !== "string") return null;
  let s = v.trim().toLowerCase();
  if (!s.startsWith("#")) s = `#${s}`;
  if (/^#[0-9a-f]{3}$/.test(s)) s = `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  return HEX.test(s) ? s : null;
}

const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const hex = (c: number[]) => `#${c.map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, "0")).join("")}`;

/** `a` moved toward `b` by t (0..1). */
export function mix(a: string, b: string, t: number): string {
  const x = rgb(a), y = rgb(b);
  return hex(x.map((v, i) => v + (y[i] - v) * t));
}

function luminance(h: string): number {
  const [r, g, b] = rgb(h).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1..21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Text on the accent: whichever of black and white reads better. */
export const onColor = (h: string) => (contrast(h, "#0a0a0a") >= contrast(h, "#ffffff") ? "#0a0a0a" : "#ffffff");

// ---------- tokens ----------

/** Every colour token the app uses, derived from accent, background and ink. */
export function paletteTokens(p: Palette, dark: boolean): Record<string, string> {
  const { bg, ink, accent } = p;
  return {
    "--bg": bg,
    "--surface-100": mix(bg, ink, dark ? 0.03 : 0.02),
    "--surface-200": mix(bg, ink, dark ? 0.06 : 0.05),
    "--surface-300": mix(bg, ink, dark ? 0.1 : 0.09),
    "--border": mix(bg, ink, dark ? 0.08 : 0.075),
    "--border-strong": mix(bg, ink, dark ? 0.42 : 0.46),
    "--ink": ink,
    "--on-ink": bg,
    "--ink-muted": mix(ink, bg, dark ? 0.32 : 0.33),
    "--ink-faint": mix(ink, bg, dark ? 0.42 : 0.4),
    "--highlight": accent,
    "--on-highlight": onColor(accent),
    "--highlight-soft": mix(accent, bg, dark ? 0.82 : 0.65),
    "--focus-ring": dark ? accent : ink,
  };
}

/** Font, spacing and corner tokens; empty for the defaults. */
export function shapeTokens(t: Pick<Theme, "font" | "density" | "radius">): Record<string, string> {
  const out: Record<string, string> = {};
  if (t.font !== "instrument") out["--font-sans"] = FONTS[t.font].stack;
  const d = DENSITIES[t.density].scale;
  if (d !== 1) for (const [k, px] of [[1, 4], [2, 8], [3, 12], [4, 16], [6, 24], [8, 32], [12, 48]]) out[`--space-${k}`] = `${Math.round(px * d)}px`;
  const r = RADII[t.radius].scale;
  if (r !== 1) for (const [k, px] of [["sm", 4], ["md", 8], ["lg", 14]] as const) out[`--radius-${k}`] = `${Math.round(px * r)}px`;
  return out;
}

const decls = (vars: Record<string, string>) => Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(";");

/**
 * The stylesheet for a theme: variables only, light on :root, dark under the same two selectors
 * globals.css uses (system dark, and data-theme="dark"). A little more specific than globals.css,
 * so it wins whatever order the sheets load in. The default theme is "".
 */
export function themeCss(t: Theme | null | undefined): string {
  if (!t || t.id === DEFAULT_ID) return "";
  const shape = shapeTokens(t);
  const light = decls({ ...paletteTokens(t.light, false), ...shape });
  const dark = decls(paletteTokens(t.dark, true));
  return [
    `html:root{${light}}`,
    `@media (prefers-color-scheme: dark){html:root:not([data-theme="light"]){${dark};color-scheme:dark}}`,
    `html:root[data-theme="dark"]{${dark};color-scheme:dark}`,
  ].join("\n") + "\n";
}

/** Variables for a live preview box (light or dark), set as an inline style. */
export function previewVars(t: Theme, dark: boolean): Record<string, string> {
  return { ...paletteTokens(dark ? t.dark : t.light, dark), ...shapeTokens(t) };
}

// ---------- validation ----------

const ID = /^[a-z0-9-]{1,40}$/;

function palette(v: unknown, fallback: Palette): Palette | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const accent = normHex(o.accent ?? fallback.accent), bg = normHex(o.bg ?? fallback.bg), ink = normHex(o.ink ?? fallback.ink);
  return accent && bg && ink ? { accent, bg, ink } : null;
}

/** A theme from untrusted JSON (an import, a form), or why it can't be used. */
export function parseTheme(v: unknown, newId?: () => string): { theme: Theme } | { error: string } {
  if (!v || typeof v !== "object" || Array.isArray(v)) return { error: "That isn't a theme." };
  const o = v as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name.replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 40) : "";
  if (!name) return { error: "A theme needs a name." };
  const light = palette(o.light, DEFAULT_THEME.light);
  const dark = palette(o.dark, DEFAULT_THEME.dark);
  if (!light || !dark) return { error: "Colours must be hex, like #d6ff3d." };
  const font = typeof o.font === "string" && o.font in FONTS ? (o.font as FontId) : null;
  const density = typeof o.density === "string" && o.density in DENSITIES ? (o.density as Density) : null;
  const radius = typeof o.radius === "string" && o.radius in RADII ? (o.radius as Radius) : null;
  if (o.font !== undefined && !font) return { error: `Font must be one of: ${Object.keys(FONTS).join(", ")}.` };
  if (o.density !== undefined && !density) return { error: `Density must be one of: ${Object.keys(DENSITIES).join(", ")}.` };
  if (o.radius !== undefined && !radius) return { error: `Radius must be one of: ${Object.keys(RADII).join(", ")}.` };
  let id = typeof o.id === "string" && ID.test(o.id) && o.id !== DEFAULT_ID ? o.id : newId?.() ?? "";
  if (!ID.test(id) || id === DEFAULT_ID) id = `t-${Math.random().toString(36).slice(2, 10)}`;
  return { theme: { id, name, light, dark, font: font ?? "instrument", density: density ?? "default", radius: radius ?? "default" } };
}

/** What Export gives: the theme without its local id. */
export function exportTheme(t: Theme): string {
  const { id: _id, ...rest } = t;
  void _id;
  return JSON.stringify({ dailyBriefTheme: 1, ...rest }, null, 2) + "\n";
}

/** Import: one exported theme, or a list of them. */
export function importThemes(json: string, newId: () => string): { themes: Theme[] } | { error: string } {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return { error: "That file isn't JSON." };
  }
  const list = Array.isArray(v) ? v : [v];
  if (!list.length || list.length > 50) return { error: "Nothing to import." };
  const out: Theme[] = [];
  for (const x of list) {
    const { id: _ignored, ...rest } = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
    void _ignored;
    const r = parseTheme(rest, newId);
    if ("error" in r) return r;
    out.push(r.theme);
  }
  return { themes: out };
}

/** Readability warnings for a theme (ink on background, both variants). */
export function themeWarnings(t: Theme): string[] {
  const w: string[] = [];
  for (const [label, p] of [["Light", t.light], ["Dark", t.dark]] as const) {
    const c = contrast(p.ink, p.bg);
    if (c < 4.5) w.push(`${label}: text on the background is hard to read (contrast ${c.toFixed(1)}:1, aim for 4.5).`);
  }
  return w;
}

/** A state file from disk, cleaned: bad themes dropped, an unknown active id falls back to the default. */
export function cleanState(v: unknown): ThemeState {
  const s = emptyThemeState();
  if (!v || typeof v !== "object") return s;
  const o = v as Record<string, unknown>;
  const seen = new Set<string>();
  for (const x of Array.isArray(o.themes) ? o.themes.slice(0, 50) : []) {
    const r = parseTheme(x);
    if ("theme" in r && !seen.has(r.theme.id) && (x as Theme).id === r.theme.id) {
      seen.add(r.theme.id);
      s.themes.push(r.theme);
    }
  }
  s.active = typeof o.active === "string" && seen.has(o.active) ? o.active : DEFAULT_ID;
  return s;
}

export function activeTheme(s: ThemeState): Theme {
  return s.themes.find((t) => t.id === s.active) ?? DEFAULT_THEME;
}
