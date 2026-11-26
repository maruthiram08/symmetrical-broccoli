// Terminal styling for the CLI. Colours only on a TTY (and never with NO_COLOR or --no-color).

import type { Item } from "@/lib/types";

export interface Style {
  color: boolean;
  /** Terminal width, for right-aligning labels. Null when not a TTY: lines are not padded. */
  width: number | null;
  bold(s: string): string;
  dim(s: string): string;
  red(s: string): string;
  lime(s: string): string;
  /** Section heading: "YOU OWE (3)". */
  head(title: string, n?: number): string;
}

const wrap = (on: boolean, open: string, close: string) => (s: string) => (on && s ? `\x1b[${open}m${s}\x1b[${close}m` : s);

export function makeStyle(opts: { color: boolean; width?: number | null }): Style {
  const c = opts.color;
  const bold = wrap(c, "1", "22");
  const dim = wrap(c, "2", "22");
  return {
    color: c,
    width: opts.width ?? null,
    bold,
    dim,
    red: wrap(c, "31", "39"),
    lime: wrap(c, "38;5;154", "39"),
    head: (title, n) => bold(title.toUpperCase()) + (n !== undefined ? dim(` ${n}`) : ""),
  };
}

/** Should this run use colour? */
export function wantColor(stream: { isTTY?: boolean }, env: Record<string, string | undefined>, flag: boolean | undefined): boolean {
  if (flag === false) return false;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== "0") return true;
  return !!stream.isTTY && env.TERM !== "dumb";
}

/** The item's mark, same shapes as the app: lime square, hollow circle, diamond, red square, faded dot. */
export function mark(i: Pick<Item, "kind" | "status">, late: boolean, st: Style): string {
  if (i.status !== "open") return st.dim("·");
  if (late) return st.red("■");
  if (i.kind === "owe") return st.lime("■");
  if (i.kind === "waiting") return "○";
  return "◆";
}

const ANSI = /\x1b\[[0-9;]*m/g;
/** Visible length (no escape codes; wide characters count as one). */
export const visible = (s: string) => [...s.replace(ANSI, "")].length;

/**
 * `prefix` + `text`, with `right` at the right edge when the width is known (else two spaces
 * after). `text` is plain: it is cut with "…" to fit, then painted.
 */
export function line(prefix: string, text: string, right: string, st: Style, paint: (s: string) => string = (x) => x): string {
  if (!st.width) return paint(prefix + text) + (right ? `  ${right}` : "");
  const room = st.width - visible(prefix) - (right ? visible(right) + 2 : 0);
  let t = text;
  const chars = [...t];
  if (chars.length > room && room > 10) t = chars.slice(0, room - 1).join("") + "…";
  if (!right) return paint(prefix + t);
  return paint(prefix + t) + " ".repeat(Math.max(2, st.width - visible(prefix) - [...t].length - visible(right))) + right;
}
