// YAML front matter on notes, read and written without a YAML library and without reformatting.
// A note's front matter is kept as raw text: reading it never changes it, so an untouched note is
// saved byte for byte. Changing one property rewrites only that property's lines; every other line
// (comments, blank lines, keys we can't read, key order, quoting, line endings) stays as it was.
//
// Read: `key: scalar`, `key: [a, "b"]`, and block lists (`key:` then `  - a` lines). Anything else
// (nested maps, `|` / `>` blocks, anchors) is kept as a "raw" property: shown, never rewritten.

export type PropValue = string | number | boolean | string[] | null;

export interface FrontMatter {
  /** The front matter exactly as in the file, fences and BOM included; "" when there is none. */
  raw: string;
  /** Everything after it, exactly as in the file. */
  body: string;
}

const OPEN = /^(﻿?)---[ \t]*(\r?\n)/;

/** Split a note into its front matter (raw, fences included) and body. raw + body === md, always. */
export function splitFrontMatter(md: string): FrontMatter {
  const open = md.match(OPEN);
  if (!open) return { raw: "", body: md };
  let at = open[0].length;
  while (at <= md.length) {
    const nl = md.indexOf("\n", at);
    const end = nl < 0 ? md.length : nl + 1;
    const line = md.slice(at, nl < 0 ? md.length : nl).replace(/\r$/, "");
    if (/^(?:---|\.\.\.)[ \t]*$/.test(line)) return { raw: md.slice(0, end), body: md.slice(end) };
    if (nl < 0) break;
    at = end;
  }
  // No closing fence: not front matter (a note that starts with a divider).
  return { raw: "", body: md };
}

export const joinFrontMatter = (fm: FrontMatter) => fm.raw + fm.body;

export interface PropEntry {
  key: string;
  value: PropValue;
  /** "raw" when we can show but not safely rewrite it. */
  kind: "scalar" | "flow" | "block" | "raw";
  /** The text of the value as written (for raw ones). */
  text: string;
}

interface Block {
  /** null for lines that aren't a top-level key (comments, blanks, unreadable). */
  key: string | null;
  lines: string[];
}


/** The lines between the fences, each without its line ending. raw === head + lines + tail. */
function innerLines(raw: string): { head: string; lines: string[]; tail: string; eol: string } {
  const open = raw.match(OPEN)!;
  const head = open[0];
  const eol = open[2];
  const endNl = raw.endsWith("\r\n") ? "\r\n" : raw.endsWith("\n") ? "\n" : "";
  const noEnd = raw.slice(0, raw.length - endNl.length);
  const idx = noEnd.lastIndexOf("\n");
  const inner = idx + 1 > head.length ? noEnd.slice(head.length, idx + 1) : "";
  const tail = noEnd.slice(Math.max(idx + 1, head.length)) + endNl;
  const lines = inner ? inner.replace(/\r?\n$/, "").split(/\r?\n/) : [];
  return { head, lines, tail, eol };
}

const KEY_LINE = /^([A-Za-z0-9_][\w .-]*?|"[^"]+"|'[^']+')[ \t]*:(?:[ \t]+(.*)|[ \t]*)$/;

function blocksOf(lines: string[]): Block[] {
  const out: Block[] = [];
  for (const line of lines) {
    const m = line.match(KEY_LINE);
    if (m && !/^\s/.test(line)) {
      out.push({ key: unquoteKey(m[1]), lines: [line] });
      continue;
    }
    const last = out[out.length - 1];
    // Continuation of the key above: indented lines, or "- item" lines right under a bare "key:".
    const bare = !!last?.key && /:\s*$/.test(stripComment(last.lines[0]));
    if (last && last.key !== null && (/^\s+\S/.test(line) || (bare && /^-(\s|$)/.test(line)))) {
      last.lines.push(line);
      continue;
    }
    out.push({ key: null, lines: [line] });
  }
  return out;
}

const unquoteKey = (k: string) => (/^["']/.test(k) ? k.slice(1, -1) : k.trim());

/** Strip an unquoted trailing " # comment". */
function stripComment(s: string): string {
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q && (q === "'" || s[i - 1] !== "\\")) q = null; continue; }
    if (c === '"' || c === "'") { if (i === 0 || /[\s[,]/.test(s[i - 1])) q = c; continue; }
    if (c === "#" && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trimEnd();
  }
  return s;
}

function unquote(s: string): string | null {
  if (s.length >= 2 && s[0] === '"' && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\(["\\/nt])/g, (_m, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c));
  }
  if (s.length >= 2 && s[0] === "'" && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return null;
}

/** One scalar: quoted string, true/false, number, null, or plain text. */
export function parseScalar(raw: string): PropValue {
  const s = stripComment(raw.trim());
  if (s === "" || s === "~" || s === "null" || s === "Null" || s === "NULL") return null;
  const q = unquote(s);
  if (q !== null) return q;
  if (/^(?:true|True|TRUE)$/.test(s)) return true;
  if (/^(?:false|False|FALSE)$/.test(s)) return false;
  if (/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(s) && !/^0\d/.test(s)) return Number(s);
  return s;
}

/** "[a, "b, c", d]" -> ["a", "b, c", "d"]. Null when it isn't one flat list. */
function parseFlow(s: string): string[] | null {
  const t = stripComment(s.trim());
  if (!t.startsWith("[") || !t.endsWith("]")) return null;
  const inner = t.slice(1, -1);
  if (/[[\]{}]/.test(inner.replace(/"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'/g, ""))) return null;
  const out: string[] = [];
  let cur = "", q: string | null = null;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (q) { cur += c; if (c === q && (q === "'" || inner[i - 1] !== "\\")) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === ",") { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim() || out.length) out.push(cur);
  return out.map((x) => x.trim()).filter((x) => x !== "").map((x) => { const v = parseScalar(x); return v === null ? "" : String(v); });
}

function readBlock(b: Block): PropEntry {
  const key = b.key!;
  const m = b.lines[0].match(KEY_LINE)!;
  const first = (m[2] ?? "").trim();
  const rest = b.lines.slice(1);
  const text = [first, ...rest].join("\n");
  if (rest.length === 0) {
    if (first.startsWith("[")) {
      const flow = parseFlow(first);
      return flow ? { key, value: flow, kind: "flow", text } : { key, value: first, kind: "raw", text };
    }
    if (/^[|>&*!{]/.test(first)) return { key, value: first, kind: "raw", text };
    return { key, value: parseScalar(first), kind: "scalar", text };
  }
  const items = rest.filter((l) => l.trim() !== "" && !/^\s*#/.test(l));
  if (stripComment(first) === "" && items.length && items.every((l) => /^\s*-\s+\S/.test(l))) {
    const vals = items.map((l) => stripComment(l.replace(/^\s*-\s+/, "")));
    if (vals.every((v) => unquote(v) !== null || (!/^[[{|>&*!]/.test(v) && !/:(\s|$)/.test(v)))) {
      return { key, value: vals.map((v) => { const x = parseScalar(v); return x === null ? "" : String(x); }), kind: "block", text };
    }
  }
  return { key, value: text, kind: "raw", text };
}

/** Every property in the front matter, in file order. Later duplicates are left out. */
export function readEntries(raw: string): PropEntry[] {
  if (!raw) return [];
  const { lines } = innerLines(raw);
  const seen = new Set<string>();
  const out: PropEntry[] = [];
  for (const b of blocksOf(lines)) {
    if (b.key === null || seen.has(b.key)) continue;
    seen.add(b.key);
    out.push(readBlock(b));
  }
  return out;
}

/** A note's properties as a plain record (raw ones as their text). */
export function readProperties(md: string): Record<string, PropValue> {
  const out: Record<string, PropValue> = {};
  for (const e of readEntries(splitFrontMatter(md).raw)) out[e.key] = e.value;
  return out;
}

const RESERVED = /^(?:true|false|yes|no|on|off|null|~)$/i;

/** A string as YAML, quoted only when it has to be. */
export function yamlString(s: string, inFlow = false): string {
  const needs =
    (inFlow && /[,[\]{}]/.test(s)) ||
    s === "" || s !== s.trim() || RESERVED.test(s) ||
    /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(s) ||
    /^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(s) || /:(\s|$)/.test(s) || /\s#/.test(s) || /[\n\t\\"]/.test(s) || /\[\[|\]\]/.test(s);
  if (!needs) return s;
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"`;
}

export function yamlScalar(v: Exclude<PropValue, string[]>): string {
  if (v === null) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : yamlString(String(v));
  return yamlString(v);
}

const safeKey = (k: string) => (/^[A-Za-z0-9_][\w.-]*$/.test(k) ? k : yamlString(k));

/** The lines for one property. Keeps the list style (flow or block) and indent it had. */
function renderBlock(key: string, value: PropValue, was?: Block): string[] {
  const k = was ? was.lines[0].slice(0, was.lines[0].indexOf(":")) : safeKey(key);
  if (Array.isArray(value)) {
    const wasBlock = was && was.lines.length > 1 && was.lines.slice(1).some((l) => /^\s*-/.test(l));
    if (wasBlock && value.length) {
      const indent = was!.lines.slice(1).find((l) => /^\s*-/.test(l))!.match(/^\s*/)![0];
      return [`${k}:`, ...value.map((x) => `${indent}- ${yamlString(x)}`)];
    }
    return [`${k}: [${value.map((x) => yamlString(x, true)).join(", ")}]`];
  }
  const s = yamlScalar(value);
  return [s === "" ? `${k}:` : `${k}: ${s}`];
}

function sameValue(a: PropValue, b: PropValue): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);
  return a === b;
}

/**
 * Set (or with `undefined`, remove) properties. Only the lines of changed keys are rewritten; a key
 * whose value is the same is left exactly as written. New keys go at the end. A note with no front
 * matter gets one, using the note's own line endings.
 */
export function setProperties(md: string, changes: Record<string, PropValue | undefined>): string {
  const fm = splitFrontMatter(md);
  const keys = Object.keys(changes);
  if (!keys.length) return md;
  if (!fm.raw) {
    const add = keys.filter((k) => changes[k] !== undefined);
    if (!add.length) return md;
    const eol = /\r\n/.test(md) ? "\r\n" : "\n";
    const bom = md.startsWith("﻿") ? "﻿" : "";
    const body = bom ? md.slice(1) : md;
    const lines = add.flatMap((k) => renderBlock(k, changes[k] as PropValue));
    return `${bom}---${eol}${lines.join(eol)}${eol}---${eol}${body}`;
  }
  const { head, lines, tail, eol } = innerLines(fm.raw);
  const blocks = blocksOf(lines);
  const current = new Map<string, PropEntry>();
  for (const b of blocks) if (b.key !== null && !current.has(b.key)) current.set(b.key, readBlock(b));
  const done = new Set<string>();
  const out: string[] = [];
  let changed = false;
  for (const b of blocks) {
    if (b.key === null || !(b.key in changes) || done.has(b.key)) { out.push(...b.lines); continue; }
    done.add(b.key);
    const next = changes[b.key];
    if (next === undefined) { changed = true; continue; } // removed
    const cur = current.get(b.key)!;
    if (cur.kind !== "raw" && sameValue(cur.value, next)) { out.push(...b.lines); continue; }
    changed = true;
    out.push(...renderBlock(b.key, next, b));
  }
  // New keys go after the last property, before trailing blank lines.
  const add = keys.filter((k) => !done.has(k) && changes[k] !== undefined).flatMap((k) => renderBlock(k, changes[k] as PropValue));
  if (!add.length && !changed) return md;
  if (add.length) {
    let at = out.length;
    while (at > 0 && out[at - 1].trim() === "") at--;
    out.splice(at, 0, ...add);
  }
  const inner = out.length ? out.join(eol) + eol : "";
  return head + inner + tail + fm.body;
}

/** Remove the front matter when it has no lines left (after removing the last property). */
export function dropEmptyFrontMatter(md: string): string {
  const fm = splitFrontMatter(md);
  if (!fm.raw) return md;
  const { lines } = innerLines(fm.raw);
  if (lines.some((l) => l.trim() !== "")) return md;
  return (fm.raw.startsWith("﻿") ? "﻿" : "") + fm.body;
}
