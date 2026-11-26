import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readThemes, writeThemes } from "@/server/local/themes";
import {
  DEFAULT_ID, DEFAULT_THEME, activeTheme, cleanState, contrast, exportTheme, importThemes, mix, normHex, onColor, paletteTokens,
  parseTheme, shapeTokens, themeCss, themeWarnings, type Theme,
} from "./theme";

const mine: Theme = {
  id: "t-ocean", name: "Ocean", light: { accent: "#38bdf8", bg: "#f8fafc", ink: "#0f172a" }, dark: { accent: "#38bdf8", bg: "#020617", ink: "#e2e8f0" },
  font: "serif", density: "compact", radius: "round",
};
let k = 0;
const newId = () => `t-new${++k}`;

describe("themes", () => {
  it("the default theme writes no CSS, so the app looks exactly as designed", () => {
    expect(themeCss(DEFAULT_THEME)).toBe("");
    expect(themeCss(null)).toBe("");
    expect(shapeTokens(DEFAULT_THEME)).toEqual({});
    // Its tokens are the ones in globals.css.
    expect(paletteTokens(DEFAULT_THEME.light, false)).toMatchObject({ "--bg": "#ffffff", "--ink": "#0a0a0a", "--highlight": "#d6ff3d", "--on-highlight": "#0a0a0a", "--surface-100": "#fafafa" });
    expect(paletteTokens(DEFAULT_THEME.dark, true)).toMatchObject({ "--bg": "#0b0b0c", "--ink": "#f4f4f5", "--focus-ring": "#d6ff3d" });
  });

  it("a theme is CSS variables only, light and dark, more specific than globals.css", () => {
    const css = themeCss(mine);
    const rules = css.replace(/@media[^{]+\{/g, "").replace(/\}\}/g, "}").split("}").map((r) => r.trim()).filter(Boolean);
    expect(rules).toHaveLength(3);
    for (const r of rules) {
      const [sel, body] = r.split("{");
      expect(sel.trim()).toMatch(/^html:root/);
      for (const d of body.split(";").filter(Boolean)) expect(d).toMatch(/^(--[a-z0-9-]+|color-scheme):/);
    }
    expect(css).toContain("--bg:#f8fafc");
    expect(css).toContain('@media (prefers-color-scheme: dark){html:root:not([data-theme="light"]){--bg:#020617');
    expect(css).toContain('html:root[data-theme="dark"]{--bg:#020617');
    expect(css).toContain("--font-sans:Charter");
    expect(css).toContain("--space-4:13px");
    expect(css).toContain("--radius-md:13px");
  });

  it("validates everything that goes into the stylesheet", () => {
    expect(normHex("#ABC")).toBe("#aabbcc");
    expect(normHex("d6ff3d")).toBe("#d6ff3d");
    expect(normHex("red;}body{display:none")).toBeNull();
    expect(parseTheme({ ...mine, light: { ...mine.light, bg: "url(javascript:x)" } })).toEqual({ error: expect.stringMatching(/hex/) });
    expect(parseTheme({ ...mine, font: "Comic Sans" })).toEqual({ error: expect.stringMatching(/Font/) });
    expect(parseTheme({ ...mine, name: "" })).toEqual({ error: expect.any(String) });
    const r = parseTheme({ ...mine, name: "<b>Hi</b>", id: "default" }, newId);
    expect("theme" in r && r.theme.id).not.toBe(DEFAULT_ID);
    expect("theme" in r && r.theme.name).toBe("bHi/b");
  });

  it("exports and imports as JSON, with a fresh id", () => {
    const json = exportTheme(mine);
    expect(JSON.parse(json)).not.toHaveProperty("id");
    const r = importThemes(json, newId);
    expect("themes" in r && r.themes[0]).toEqual({ ...mine, id: expect.stringMatching(/^t-new/) });
    const two = importThemes(JSON.stringify([JSON.parse(json), { ...JSON.parse(json), name: "Two" }]), newId);
    expect("themes" in two && two.themes.map((t) => t.name)).toEqual(["Ocean", "Two"]);
    expect(importThemes("nope", newId)).toEqual({ error: expect.any(String) });
    expect(importThemes(JSON.stringify({ name: "Bad", light: { bg: "x" } }), newId)).toEqual({ error: expect.any(String) });
  });

  it("derives readable colours and warns about poor contrast", () => {
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 0);
    expect(onColor("#d6ff3d")).toBe("#0a0a0a");
    expect(onColor("#1d4ed8")).toBe("#ffffff");
    expect(themeWarnings(mine)).toEqual([]);
    expect(themeWarnings({ ...mine, light: { ...mine.light, ink: "#dddddd" } })[0]).toMatch(/^Light/);
  });

  it("stores several themes and switches between them", () => {
    const path = join(mkdtempSync(join(tmpdir(), "db-themes-")), "themes.json");
    expect(readThemes(path)).toEqual({ active: DEFAULT_ID, themes: [] });
    writeThemes({ active: "t-ocean", themes: [mine, { ...mine, id: "t-two", name: "Two" }] }, path);
    const s = readThemes(path);
    expect(s.themes.map((t) => t.name)).toEqual(["Ocean", "Two"]);
    expect(activeTheme(s).id).toBe("t-ocean");
    writeThemes({ ...s, active: "t-two" }, path);
    expect(activeTheme(readThemes(path)).name).toBe("Two");
    // An unknown active id, or a damaged entry, falls back safely.
    expect(activeTheme(cleanState({ active: "gone", themes: [mine, { id: "x", name: "bad", light: { bg: "nope" } }] }))).toBe(DEFAULT_THEME);
    expect(cleanState({ themes: [mine, { id: "x", name: "bad", light: { bg: "nope" } }] }).themes).toHaveLength(1);
    expect(JSON.parse(readFileSync(path, "utf8")).active).toBe("t-two");
  });
});
