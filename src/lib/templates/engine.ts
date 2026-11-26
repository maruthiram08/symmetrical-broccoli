// A small Handlebars-like template engine for the Markdown notes. Pure; runs on the server and in
// the Settings preview. Supported:
//   {{name}}  {{wrap.kept}}  {{this}}  {{@index}}  {{@number}}  {{@first}}  {{@last}}
//   {{#if x}} … {{else}} … {{/if}}   {{#unless x}} … {{/unless}}   {{#each list}} … {{else}} … {{/each}}
//   {{! a comment }}
// Values are inserted as they are (the app hands over Markdown-ready text). A block tag alone on its
// line takes the whole line with it, so templates can be laid out one tag per line.

export class TemplateError extends Error {
  constructor(message: string, readonly line: number) {
    super(`Line ${line}: ${message}`);
    this.name = "TemplateError";
  }
}

type Node =
  | { t: "text"; v: string }
  | { t: "var"; path: string; line: number }
  | { t: "if"; path: string; neg: boolean; yes: Node[]; no: Node[] }
  | { t: "each"; path: string; body: Node[]; empty: Node[] };

interface Tag { start: number; end: number; kind: "open" | "close" | "else" | "comment" | "var"; name: string; arg: string; line: number }

const TAG = /\{\{(!--[\s\S]*?--|![\s\S]*?|[^{}]*?)\}\}/g;
const BLOCKS = new Set(["if", "unless", "each"]);
const PATH = /^(?:this|@index|@number|@first|@last|(?:\.\.\/)*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)$/;

function lineAt(src: string, i: number): number {
  let n = 1;
  for (let k = 0; k < i; k++) if (src.charCodeAt(k) === 10) n++;
  return n;
}

function scan(src: string): Tag[] {
  const tags: Tag[] = [];
  for (const m of src.matchAll(TAG)) {
    const raw = m[1].trim();
    const start = m.index!, end = start + m[0].length, line = lineAt(src, start);
    if (raw.startsWith("!")) { tags.push({ start, end, kind: "comment", name: "", arg: "", line }); continue; }
    if (raw === "else") { tags.push({ start, end, kind: "else", name: "else", arg: "", line }); continue; }
    if (raw.startsWith("#")) {
      const [name, ...rest] = raw.slice(1).trim().split(/\s+/);
      if (!BLOCKS.has(name)) throw new TemplateError(`unknown block “#${name}”. Use #if, #unless or #each.`, line);
      const arg = rest.join(" ");
      if (!PATH.test(arg)) throw new TemplateError(`“{{#${name}}}” needs a field name, like {{#${name} youOwe}}.`, line);
      tags.push({ start, end, kind: "open", name, arg, line });
      continue;
    }
    if (raw.startsWith("/")) { tags.push({ start, end, kind: "close", name: raw.slice(1).trim(), arg: "", line }); continue; }
    if (!PATH.test(raw)) throw new TemplateError(`“{{${raw}}}” isn't a field name.`, line);
    tags.push({ start, end, kind: "var", name: raw, arg: "", line });
  }
  // Standalone block tags take their whole line (indent and newline) with them.
  for (const tag of tags) {
    if (tag.kind === "var") continue;
    const lineStart = src.lastIndexOf("\n", tag.start - 1) + 1;
    const nl = src.indexOf("\n", tag.end);
    const lineEnd = nl < 0 ? src.length : nl;
    if (/^[ \t]*$/.test(src.slice(lineStart, tag.start)) && /^[ \t]*$/.test(src.slice(tag.end, lineEnd)) && !src.slice(lineStart, tag.start).includes("}}")) {
      tag.start = lineStart;
      tag.end = nl < 0 ? src.length : nl + 1;
    }
  }
  return tags;
}

/** Parse a template. Throws TemplateError (with a line number) when it doesn't make sense. */
export function parseTemplate(src: string): Node[] {
  const tags = scan(src.replace(/\r\n/g, "\n"));
  const text = src.replace(/\r\n/g, "\n");
  const root: Node[] = [];
  type Frame = { node: Extract<Node, { t: "if" | "each" }>; name: string; into: Node[]; line: number; sawElse: boolean };
  const stack: Frame[] = [];
  let out = root;
  let pos = 0;
  for (const tag of tags) {
    if (tag.start > pos) out.push({ t: "text", v: text.slice(pos, tag.start) });
    pos = Math.max(pos, tag.end);
    if (tag.kind === "comment") continue;
    if (tag.kind === "var") { out.push({ t: "var", path: tag.name, line: tag.line }); continue; }
    if (tag.kind === "open") {
      const node: Frame["node"] = tag.name === "each"
        ? { t: "each", path: tag.arg, body: [], empty: [] }
        : { t: "if", path: tag.arg, neg: tag.name === "unless", yes: [], no: [] };
      out.push(node);
      const into = node.t === "each" ? node.body : node.yes;
      stack.push({ node, name: tag.name, into, line: tag.line, sawElse: false });
      out = into;
      continue;
    }
    const top = stack[stack.length - 1];
    if (tag.kind === "else") {
      if (!top) throw new TemplateError("“{{else}}” outside a block.", tag.line);
      if (top.sawElse) throw new TemplateError(`a second “{{else}}” in {{#${top.name}}}.`, tag.line);
      top.sawElse = true;
      out = top.node.t === "each" ? top.node.empty : top.node.no;
      continue;
    }
    if (!top) throw new TemplateError(`“{{/${tag.name}}}” closes nothing.`, tag.line);
    if (top.name !== tag.name) throw new TemplateError(`“{{/${tag.name}}}” where {{/${top.name}}} was expected (opened on line ${top.line}).`, tag.line);
    stack.pop();
    out = stack.length ? (() => { const f = stack[stack.length - 1]; return f.sawElse ? (f.node.t === "each" ? f.node.empty : f.node.no) : f.into; })() : root;
  }
  if (pos < text.length) out.push({ t: "text", v: text.slice(pos) });
  if (stack.length) {
    const f = stack[stack.length - 1];
    throw new TemplateError(`“{{#${f.name} ${f.node.path}}}” is never closed. Add {{/${f.name}}}.`, f.line);
  }
  return root;
}

interface Scope { value: unknown; meta?: { index: number; length: number } }

function lookup(path: string, scopes: Scope[]): unknown {
  const top = scopes[scopes.length - 1];
  if (path === "this") return top.value;
  if (path.startsWith("@")) {
    const meta = [...scopes].reverse().find((s) => s.meta)?.meta;
    if (!meta) return undefined;
    return { "@index": meta.index, "@number": meta.index + 1, "@first": meta.index === 0, "@last": meta.index === meta.length - 1 }[path];
  }
  let up = 0;
  let p = path;
  while (p.startsWith("../")) { up++; p = p.slice(3); }
  const [head, ...rest] = p.split(".");
  for (let k = scopes.length - 1 - up; k >= 0; k--) {
    const v = scopes[k].value;
    if (v && typeof v === "object" && own(v, head)) {
      let cur: unknown = (v as Record<string, unknown>)[head];
      for (const r of rest) cur = cur && typeof cur === "object" && own(cur, r) ? (cur as Record<string, unknown>)[r] : undefined;
      return cur;
    }
  }
  return undefined;
}

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const truthy = (v: unknown) => (Array.isArray(v) ? v.length > 0 : !!v);

function show(v: unknown): string {
  if (v === null || v === undefined || v === false) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || v === true) return String(v);
  return "";
}

function run(nodes: Node[], scopes: Scope[], out: string[]): void {
  for (const n of nodes) {
    if (n.t === "text") out.push(n.v);
    else if (n.t === "var") out.push(show(lookup(n.path, scopes)));
    else if (n.t === "if") run(truthy(lookup(n.path, scopes)) !== n.neg ? n.yes : n.no, scopes, out);
    else {
      const list = lookup(n.path, scopes);
      if (!Array.isArray(list) || !list.length) { run(n.empty, scopes, out); continue; }
      list.forEach((value, index) => run(n.body, [...scopes, { value, meta: { index, length: list.length } }], out));
    }
  }
}

/** Render a template against data. Throws TemplateError for a broken template. */
export function renderTemplate(src: string, data: unknown): string {
  const out: string[] = [];
  run(parseTemplate(src), [{ value: data }], out);
  return out.join("");
}

/** The tidy-up every generated note gets: no runs of blank lines, one newline at the end. */
export function tidyMarkdown(s: string): string {
  return s.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/** Check a template: null when fine, else the message to show. */
export function templateProblem(src: string): string | null {
  try {
    parseTemplate(src);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : "This template can't be read.";
  }
}
