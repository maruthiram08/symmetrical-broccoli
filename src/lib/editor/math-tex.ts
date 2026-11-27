// LaTeX in notes, the parts with no browser: the TeX inside a math node, and whether a note has
// math turned off ("math: false" in its properties, for notes full of prices).

/** The TeX of an InlineMath or BlockMath node's text: delimiters off, quote markers off. */
export function mathSource(raw: string, display: boolean): string {
  if (!display) return raw.startsWith("$$") ? raw.slice(2, -2) : raw.slice(1, -1);
  const lines = raw.split(/\r?\n/).map((l, i) => (i === 0 ? l : l.replace(/^[ \t]*(?:>[ \t]?)*/, "")));
  const body = lines.join("\n").replace(/^\$\$/, "").replace(/\$\$[ \t]*$/, "");
  return body.trim();
}

const FRONT = /^﻿?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** True unless the note's properties say `math: false` (or off / no). */
export function mathEnabled(md: string): boolean {
  const m = md.slice(0, 20_000).match(FRONT);
  if (!m) return true;
  const line = m[1].match(/^math[ \t]*:[ \t]*["']?(false|off|no)["']?[ \t]*$/im);
  return !line;
}
