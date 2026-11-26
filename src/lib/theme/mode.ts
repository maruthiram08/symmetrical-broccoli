// Light, dark or follow the system. Kept in a cookie so the server renders the right one (no flash).
export const MODE_COOKIE = "db-mode";
export type Mode = "system" | "light" | "dark";
export const MODES: { id: Mode; label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];
export function parseMode(v: string | undefined | null): Mode {
  return v === "light" || v === "dark" ? v : "system";
}
/** The html data-theme attribute globals.css reads; none means follow the system. */
export function themeAttr(m: Mode): "light" | "dark" | undefined {
  return m === "system" ? undefined : m;
}
