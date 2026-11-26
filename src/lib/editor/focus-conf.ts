// Focus mode's setting, kept in this browser. Separate from the editor code, so a page can show
// the toggle without loading CodeMirror.
export type FocusUnit = "paragraph" | "sentence";
export interface FocusConf { on: boolean; unit: FocusUnit; typewriter: boolean }

export const FOCUS_EVENT = "db:focusmode";
export const FOCUS_KEY = "db-focus-mode";
export const FOCUS_OFF: FocusConf = { on: false, unit: "paragraph", typewriter: true };

export function parseFocusConf(raw: string | null): FocusConf {
  if (!raw) return { ...FOCUS_OFF };
  try {
    const o = JSON.parse(raw) as Partial<FocusConf>;
    return { on: o.on === true, unit: o.unit === "sentence" ? "sentence" : "paragraph", typewriter: o.typewriter !== false };
  } catch {
    return { ...FOCUS_OFF };
  }
}

export function readFocusConf(): FocusConf {
  try { return parseFocusConf(localStorage.getItem(FOCUS_KEY)); } catch { return { ...FOCUS_OFF }; }
}

/** Save the setting and tell every open editor. */
export function writeFocusConf(c: FocusConf): void {
  try { localStorage.setItem(FOCUS_KEY, JSON.stringify(c)); } catch { /* storage off: still applies to this page */ }
  try { window.dispatchEvent(new CustomEvent<FocusConf>(FOCUS_EVENT, { detail: c })); } catch { /* not in a browser */ }
}

export function toggleFocusMode(): FocusConf {
  const next = { ...readFocusConf() };
  next.on = !next.on;
  writeFocusConf(next);
  return next;
}

