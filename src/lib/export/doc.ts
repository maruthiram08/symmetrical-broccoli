// Notes Markdown as a small block tree, shared by the HTML and Word exports. Read with the same
// parser as the editor (CommonMark + GFM + [[wiki links]]), so what exports is what you see.
// Pure; no DOM.
import type { SyntaxNode } from "@lezer/common";
import { notesParser } from "@/lib/editor/markdown";
import { parseWikiLink } from "@/lib/editor/links";

export type Inline =
  | { t: "text"; v: string }
  | { t: "b" | "i" | "s"; c: Inline[] }
  | { t: "code"; v: string }
  | { t: "link"; href: string; c: Inline[] }
  /** A [[link]]: shown as its label, never as a link back to this Mac. */
  | { t: "wiki"; label: string }
  | { t: "br" };

export interface ListEntry {
  /** null: not a task. */
  checked: boolean | null;
  blocks: Block[];
}

export type Block =
  | { t: "h"; level: 1 | 2 | 3 | 4 | 5 | 6; c: Inline[] }
  | { t: "p"; c: Inline[] }
  | { t: "list"; ordered: boolean; start: number; items: ListEntry[] }
  | { t: "quote"; blocks: Block[] }
  | { t: "callout"; kind: string; title: Inline[]; blocks: Block[] }
  | { t: "code"; lang: string; v: string }
  | { t: "hr" }
  | { t: "table"; head: Inline[][]; rows: Inline[][][] };

/** A page to export: a title, an optional line under it, and its Markdown. */
export interface ExportDoc {
  title: string;
  subtitle?: string | null;
  markdown: string;
}

const SKIP = new Set(["EmphasisMark", "CodeMark", "LinkMark", "QuoteMark", "HeaderMark", "ListMark", "TaskMarker", "StrikethroughMark", "TableDelimiter", "CodeInfo", "LinkTitle", "LinkLabel"]);

/** Text between inline nodes: soft line breaks become spaces; quote marks and indents go. */
function gap(md: string, from: number, to: number): string {
  return md.slice(from, to).replace(/\r?\n[ \t]*(?:>[ \t]?)*[ \t]*/g, " ");
}

function children(n: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let c = n.firstChild; c; c = c.nextSibling) out.push(c);
  return out;
}

function pushText(out: Inline[], v: string) {
  if (!v) return;
  const last = out[out.length - 1];
  if (last && last.t === "text") last.v += v;
  else out.push({ t: "text", v });
}

/** Inline content of `n` between `from` and `to` (defaults to the node itself). */
function inlines(md: string, n: SyntaxNode, from = n.from, to = n.to): Inline[] {
  const out: Inline[] = [];
  let at = from;
  for (const c of children(n)) {
    if (c.to <= from || c.from >= to) continue;
    if (c.from > at) pushText(out, gap(md, at, c.from));
    at = Math.max(at, c.to);
    if (SKIP.has(c.name)) continue;
    switch (c.name) {
      case "Emphasis": out.push({ t: "i", c: inlines(md, c) }); break;
      case "StrongEmphasis": out.push({ t: "b", c: inlines(md, c) }); break;
      case "Strikethrough": out.push({ t: "s", c: inlines(md, c) }); break;
      case "InlineCode": out.push({ t: "code", v: md.slice(c.from, c.to).replace(/^`+\s?|\s?`+$/g, "") }); break;
      case "WikiLink": {
        const l = parseWikiLink(md.slice(c.from, c.to));
        pushText(out, "");
        out.push({ t: "wiki", label: l?.label ?? md.slice(c.from + 2, c.to - 2) });
        break;
      }
      case "Link": {
        const url = c.getChild("URL");
        const marks = c.getChildren("LinkMark");
        const textEnd = marks[1]?.from ?? c.to;
        const body = inlines(md, c, (marks[0]?.to ?? c.from), textEnd);
        const href = url ? md.slice(url.from, url.to) : "";
        if (href && safeHref(href)) out.push({ t: "link", href, c: body });
        else out.push(...(body.length ? body : [{ t: "text" as const, v: md.slice(c.from, c.to) }]));
        break;
      }
      case "Image": {
        // Images are left out (the file stays self-contained); the alt text stays.
        const marks = c.getChildren("LinkMark");
        const alt = md.slice(marks[0]?.to ?? c.from, marks[1]?.from ?? c.to);
        if (alt) pushText(out, `[${alt}]`);
        break;
      }
      case "Autolink":
      case "URL": {
        const href = md.slice(c.from, c.to).replace(/^<|>$/g, "");
        if (safeHref(href)) out.push({ t: "link", href, c: [{ t: "text", v: href }] });
        else pushText(out, href);
        break;
      }
      case "HardBreak": out.push({ t: "br" }); break;
      case "Escape": pushText(out, md.slice(c.from + 1, c.to)); break;
      case "Entity": pushText(out, decodeEntity(md.slice(c.from, c.to))); break;
      default: pushText(out, gap(md, c.from, c.to));
    }
  }
  if (at < to) pushText(out, gap(md, at, to));
  // Trim the ends of the run.
  const first = out[0];
  if (first?.t === "text") first.v = first.v.replace(/^\s+/, "");
  const last = out[out.length - 1];
  if (last?.t === "text") last.v = last.v.replace(/\s+$/, "");
  return out.filter((x) => x.t !== "text" || x.v);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeEntity(e: string): string {
  const m = e.match(/^&(#x[0-9a-f]+|#\d+|\w+);$/i);
  if (!m) return e;
  const v = m[1];
  if (v[0] === "#") {
    const n = v[1] === "x" || v[1] === "X" ? parseInt(v.slice(2), 16) : parseInt(v.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : e;
  }
  return ENTITIES[v.toLowerCase()] ?? e;
}

/** Only web and mail links survive an export; anything else (javascript:, file:, app paths) becomes text. */
export function safeHref(h: string): boolean {
  return /^(https?:\/\/|mailto:)/i.test(h.trim());
}

function block(md: string, n: SyntaxNode, out: Block[]) {
  const name = n.name;
  const heading = name.match(/^(?:ATX|Setext)Heading(\d)$/);
  if (heading) {
    out.push({ t: "h", level: Number(heading[1]) as 1, c: inlines(md, n) });
    return;
  }
  switch (name) {
    case "Paragraph": {
      const c = inlines(md, n);
      if (c.length) out.push({ t: "p", c });
      return;
    }
    case "BulletList":
    case "OrderedList": {
      const items: ListEntry[] = [];
      let start = 1;
      for (const li of n.getChildren("ListItem")) {
        const mark = li.getChild("ListMark");
        if (name === "OrderedList" && !items.length && mark) start = parseInt(md.slice(mark.from, mark.to), 10) || 1;
        const blocks: Block[] = [];
        let checked: boolean | null = null;
        for (const c of children(li)) {
          if (c.name === "ListMark") continue;
          if (c.name === "Task") {
            const tm = c.getChild("TaskMarker");
            checked = tm ? /x/i.test(md.slice(tm.from, tm.to)) : false;
            const body = inlines(md, c);
            if (body.length) blocks.push({ t: "p", c: body });
            continue;
          }
          block(md, c, blocks);
        }
        items.push({ checked, blocks });
      }
      out.push({ t: "list", ordered: name === "OrderedList", start, items });
      return;
    }
    case "Blockquote": {
      const inner = children(n).filter((c) => c.name !== "QuoteMark");
      const first = inner[0];
      const head = first?.name === "Paragraph" ? md.slice(first.from, first.to).match(/^\[!([a-z]+)\][+-]?[ \t]*([^\n]*)/i) : null;
      if (first && head) {
        const nl = md.indexOf("\n", first.from);
        const titleEnd = nl < 0 || nl > first.to ? first.to : nl;
        const titleStart = first.from + head[0].length - head[2].length;
        const title = inlines(md, first, titleStart, titleEnd);
        const blocks: Block[] = [];
        if (titleEnd < first.to) {
          const rest = inlines(md, first, titleEnd, first.to);
          if (rest.length) blocks.push({ t: "p", c: rest });
        }
        for (const c of inner.slice(1)) block(md, c, blocks);
        out.push({ t: "callout", kind: head[1].toLowerCase(), title, blocks });
        return;
      }
      const blocks: Block[] = [];
      for (const c of inner) block(md, c, blocks);
      out.push({ t: "quote", blocks });
      return;
    }
    case "FencedCode":
    case "CodeBlock": {
      const info = n.getChild("CodeInfo");
      const texts = n.getChildren("CodeText");
      let v = texts.length ? md.slice(texts[0].from, texts[texts.length - 1].to) : name === "CodeBlock" ? md.slice(n.from, n.to) : "";
      if (name === "CodeBlock") v = v.replace(/^( {4}|\t)/gm, "");
      out.push({ t: "code", lang: info ? md.slice(info.from, info.to) : "", v });
      return;
    }
    case "HorizontalRule": out.push({ t: "hr" }); return;
    case "Table": {
      const cells = (row: SyntaxNode) => row.getChildren("TableCell").map((c) => inlines(md, c));
      const header = n.getChild("TableHeader");
      out.push({ t: "table", head: header ? cells(header) : [], rows: n.getChildren("TableRow").map(cells) });
      return;
    }
    case "HTMLBlock": {
      // Toggles (<details><summary>Title</summary>) keep their title as a bold line; other HTML is shown as text.
      const raw = md.slice(n.from, n.to);
      const summary = raw.match(/<summary>([\s\S]*?)<\/summary>/i);
      if (summary) {
        const t = summary[1].replace(/<[^>]*>/g, "").trim();
        if (t) out.push({ t: "p", c: [{ t: "b", c: [{ t: "text", v: t }] }] });
        return;
      }
      if (/^\s*<\/?details>\s*$/i.test(raw) || /^\s*<!--[\s\S]*-->\s*$/.test(raw)) return;
      out.push({ t: "p", c: [{ t: "text", v: raw.trim() }] });
      return;
    }
    case "LinkReference":
    case "CommentBlock":
    case "ProcessingInstructionBlock":
      return;
    default:
      for (const c of children(n)) block(md, c, out);
  }
}

/** Front matter and daily-brief markers are left out of an export. */
export function cleanMarkdown(md: string): string {
  return md
    .replace(/^﻿/, "")
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")
    .replace(/^[ \t]*<!--\s*daily-brief:[^>]*-->[ \t]*\r?\n?/gm, "");
}

export function parseBlocks(markdown: string): Block[] {
  const md = cleanMarkdown(markdown);
  const tree = notesParser.parse(md);
  const out: Block[] = [];
  for (let c = tree.topNode.firstChild; c; c = c.nextSibling) block(md, c.node, out);
  return out;
}

/** The text of a run, for plain-text uses (titles, tests). */
export function plain(c: Inline[]): string {
  return c.map((x) => (x.t === "text" || x.t === "code" ? x.v : x.t === "wiki" ? x.label : x.t === "br" ? "\n" : plain(x.c))).join("");
}

/** The doc's blocks; a first "# Heading" that repeats the title is dropped (the title is shown already). */
export function docBlocks(d: ExportDoc): Block[] {
  const blocks = parseBlocks(d.markdown);
  const f = blocks[0];
  if (f && f.t === "h" && f.level === 1 && plain(f.c).trim() === d.title.trim()) blocks.shift();
  return blocks;
}

/** "Q4 plan" -> "q4-plan" for file names; never empty. */
export function fileBase(title: string): string {
  return title.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60).toLowerCase() || "export";
}
