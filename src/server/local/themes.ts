// Saved themes: <first notes folder>/.daily-brief/themes.json, shared by every workspace.
import { join } from "node:path";
import { activeTheme, cleanState, type ThemeState } from "@/lib/theme/theme";
import { readJson, writeJson } from "./json-file";
import { homeDataDir } from "./workspaces";

export const themesPath = () => join(homeDataDir(), "themes.json");

export function readThemes(path = themesPath()): ThemeState {
  return cleanState(readJson<unknown>(path, {}));
}

export function writeThemes(s: ThemeState, path = themesPath()): void {
  writeJson(path, cleanState(s));
}

export const currentTheme = (path = themesPath()) => activeTheme(readThemes(path));
