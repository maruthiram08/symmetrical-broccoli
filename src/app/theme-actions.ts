"use server";

// Settings › Appearance: save, delete, switch and import themes. Themes only set CSS variables.
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { DEFAULT_ID, importThemes, parseTheme, type Theme, type ThemeState } from "@/lib/theme/theme";
import { me } from "@/server/local/app";
import { readThemes, writeThemes } from "@/server/local/themes";
import { isHosted } from "@/server/mode";

export type ThemeResult = { ok: true; state: ThemeState; id?: string; count?: number } | { ok: false; error: string };

const newId = () => `t-${randomUUID().slice(0, 8)}`;

async function guard(): Promise<string | null> {
  if (isHosted()) return "Themes are only in the Mac app.";
  if (!(await me())) return "Set up Daily brief first.";
  return null;
}

function done(state: ThemeState, extra: { id?: string; count?: number } = {}): ThemeResult {
  writeThemes(state);
  revalidatePath("/setup");
  return { ok: true, state: readThemes(), ...extra };
}

/** Save a new theme or changes to one of yours. `activate` switches to it as well. */
export async function saveThemeAction(input: Theme, activate: boolean): Promise<ThemeResult> {
  const g = await guard();
  if (g) return { ok: false, error: g };
  const parsed = parseTheme(input, newId);
  if ("error" in parsed) return { ok: false, error: parsed.error };
  const s = readThemes();
  const t = parsed.theme;
  const at = s.themes.findIndex((x) => x.id === t.id);
  if (at >= 0) s.themes[at] = t;
  else {
    if (s.themes.length >= 50) return { ok: false, error: "That's 50 themes already. Delete one first." };
    s.themes.push(t);
  }
  if (activate) s.active = t.id;
  return done(s, { id: t.id });
}

export async function applyThemeAction(id: string): Promise<ThemeResult> {
  const g = await guard();
  if (g) return { ok: false, error: g };
  const s = readThemes();
  if (id !== DEFAULT_ID && !s.themes.some((t) => t.id === id)) return { ok: false, error: "That theme is gone." };
  s.active = id;
  return done(s);
}

export async function deleteThemeAction(id: string): Promise<ThemeResult> {
  const g = await guard();
  if (g) return { ok: false, error: g };
  const s = readThemes();
  s.themes = s.themes.filter((t) => t.id !== id);
  if (s.active === id) s.active = DEFAULT_ID;
  return done(s);
}

export async function importThemesAction(json: string): Promise<ThemeResult> {
  const g = await guard();
  if (g) return { ok: false, error: g };
  if (typeof json !== "string" || json.length > 200_000) return { ok: false, error: "That file is too big for a theme." };
  const r = importThemes(json, newId);
  if ("error" in r) return { ok: false, error: r.error };
  const s = readThemes();
  if (s.themes.length + r.themes.length > 50) return { ok: false, error: "That would be more than 50 themes." };
  s.themes.push(...r.themes);
  return done(s, { id: r.themes[0]?.id, count: r.themes.length });
}
