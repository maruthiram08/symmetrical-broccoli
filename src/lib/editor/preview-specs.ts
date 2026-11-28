// Live preview, as data: which ranges of the Markdown to hide, style or draw as a widget, given
// where the cursor is. Markup is shown again on the line (or span) you are editing, so the text
// itself never changes: the preview only decorates it. Pure, so it is tested without a browser.
import { ensureSyntaxTree, foldedRanges, syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { linkHref, parseWikiLink, type LinkKind, type LinkResolver } from "./links";
import { parseLineCommand } from "./slash";
import { FOOTNOTE_DEF_RE } from "./markdown";
import { mathEnabled, mathSource } from "./math-tex";

export type Spec =
  | { t: "hide"; from: number; to: number }
  | { t: "mark"; from: number; to: number; cls: string; attrs?: Record<string, string> }
  | { t: "line"; at: number; cls: string }
  | { t: "check"; from: number; to: number; checked: boolean }
  | { t: "bullet"; from: number; to: number }
  | { t: "link"; from: number; to: number; label: string; href: string; kind: LinkKind | null }
  | { t: "hr"; from: number; to: number }
  | { t: "callout"; from: number; to: number; kind: string }
  | { t: "toggle"; from: number; to: number; title: string; folded: boolean; foldFrom: number; foldTo: number }
  | { t: "table"; from: number; to: number; rows: string[][]; align: Array<"left" | "center" | "right" | null> }
  | { t: "hint"; at: number; text: string }
  | { t: "image"; from: number; to: number; src: string; alt: string; wiki: boolean }
  | { t: "embed"; from: number; to: number; target: string; label: string }
  | { t: "footref"; from: number; to: number; label: string; text: string }
  | { t: "footdef"; from: number; to: number; label: string }
  | { t: "mermaid"; from: number; to: number; code: string }
  | { t: "math"; from: number; to: number; tex: string; display: boolean };

/** File types an embed or image shows as a picture. */
export const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i;

export const CALLOUT_RE = /^\[!([a-z]+)\][ \t]?/i;
export const DETAILS_OPEN_RE = /^\s*<details(?:\s+open)?\s*>\s*<summary>(.*?)<\/summary>\s*$/i;
export const DETAILS_CLOSE_RE = /^\s*<\/details>\s*$/i;

export interface PreviewOptions {
  /** With the editor blurred, nothing is shown raw. */
  focused: boolean;
  resolver?: LinkResolver;
}

/** Split a GFM table row into cells ("| a | b |" -> ["a", "b"]), honouring "\|". */
export function tableCells(row: string): string[] {
  let s = row.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") { cur += "|"; i++; continue; }
    if (s[i] === "|") { out.push(cur.trim()); cur = ""; continue; }
    cur += s[i];
  }
  out.push(cur.trim());
  return out;
}

export function previewSpecs(state: EditorState, opts: PreviewOptions): Spec[] {
  const tree = ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state);
  const doc = state.doc;
  const out: Spec[] = [];
  const sel = opts.focused ? state.selection.ranges : [];
  const lineOf = (pos: number) => doc.lineAt(pos);
  /** Any cursor or selection touching [from, to] (inclusive). */
  const touches = (from: number, to: number) => sel.some((r) => r.from <= to && r.to >= from);
  /** Any cursor on the lines of [from, to]. */
  const onLines = (from: number, to: number) => touches(lineOf(from).from, lineOf(to).to);
  const text = (from: number, to: number) => state.sliceDoc(from, to);
  const skipSpace = (pos: number, end: number) => { while (pos < end && (doc.sliceString(pos, pos + 1) === " " || doc.sliceString(pos, pos + 1) === "\t")) pos++; return pos; };
  const mathOn = mathEnabled(state.sliceDoc(0, Math.min(doc.length, 20_000)));
  const children = (n: SyntaxNode, name: string) => { const xs: SyntaxNode[] = []; for (let c = n.firstChild; c; c = c.nextSibling) if (c.name === name) xs.push(c); return xs; };

  // Footnote definitions ("[^1]: text"), by line: their text is the tooltip of each reference.
  const footnotes = new Map<string, string>();
  const footLines: Array<{ from: number; to: number; label: string; markEnd: number }> = [];
  if (doc.length < 2_000_000 && state.sliceDoc(0, doc.length).includes("[^")) {
    for (let ln = 1; ln <= doc.lines; ln++) {
      const line = doc.line(ln);
      const m = line.text.match(FOOTNOTE_DEF_RE);
      if (!m) continue;
      footnotes.set(m[1], line.text.slice(m[0].length).trim());
      footLines.push({ from: line.from, to: line.to, label: m[1], markEnd: line.from + m[0].length });
    }
  }
  for (const f of footLines) {
    out.push({ t: "line", at: f.from, cls: "cm-md-footdef" });
    if (!onLines(f.from, f.to)) out.push({ t: "footdef", from: f.from, to: f.markEnd, label: f.label });
  }

  tree.iterate({
    enter(ref) {
      const n = ref.node;
      const name = n.name;
      const h = name.match(/^ATXHeading(\d)$/);
      if (h) {
        out.push({ t: "line", at: n.from, cls: `cm-md-h cm-md-h${h[1]}` });
        if (!onLines(n.from, n.to)) {
          const mark = n.getChild("HeaderMark");
          if (mark && mark.from === n.from) out.push({ t: "hide", from: mark.from, to: skipSpace(mark.to, n.to) });
          const marks = children(n, "HeaderMark");
          const close = marks.length > 1 ? marks[marks.length - 1] : null;
          if (close && close.from > n.from) out.push({ t: "hide", from: close.from, to: close.to });
        }
        return;
      }
      if (name === "SetextHeading1" || name === "SetextHeading2") {
        out.push({ t: "line", at: n.from, cls: `cm-md-h cm-md-h${name.slice(-1)}` });
        return;
      }
      switch (name) {
        case "Emphasis": case "StrongEmphasis": case "Strikethrough": case "InlineCode": case "Highlight": {
          const cls = { Emphasis: "cm-md-em", StrongEmphasis: "cm-md-strong", Strikethrough: "cm-md-strike", InlineCode: "cm-md-code", Highlight: "cm-md-highlight" }[name];
          out.push({ t: "mark", from: n.from, to: n.to, cls });
          // Markup shows only on the line being edited.
          if (!onLines(n.from, n.to)) {
            for (const markName of ["EmphasisMark", "StrikethroughMark", "CodeMark", "HighlightMark"]) for (const m of children(n, markName)) out.push({ t: "hide", from: m.from, to: m.to });
          }
          return name === "InlineCode" ? false : undefined;
        }
        case "Link": {
          const marks = children(n, "LinkMark");
          const url = n.getChild("URL");
          if (marks.length >= 2 && marks[0].from === n.from && text(marks[0].from, marks[0].to) === "[") {
            const href = url ? text(url.from, url.to) : "";
            out.push({ t: "mark", from: marks[0].to, to: marks[1].from, cls: "cm-md-link", attrs: href ? { "data-href": href } : undefined });
            if (!onLines(n.from, n.to)) {
              out.push({ t: "hide", from: n.from, to: marks[0].to });
              out.push({ t: "hide", from: marks[1].from, to: n.to });
            }
          }
          return false;
        }
        case "Image": {
          const marks = children(n, "LinkMark");
          const url = n.getChild("URL");
          if (!url || marks.length < 2) return false;
          if (onLines(n.from, n.to)) out.push({ t: "mark", from: n.from, to: n.to, cls: "cm-md-imgraw" });
          else out.push({ t: "image", from: n.from, to: n.to, src: text(url.from, url.to).replace(/^<|>$/g, ""), alt: text(marks[0].to, marks[1].from), wiki: false });
          return false;
        }
        case "Embed": {
          const l = parseWikiLink(text(n.from + 1, n.to), n.from + 1);
          if (!l) return false;
          if (onLines(n.from, n.to)) { out.push({ t: "mark", from: n.from, to: n.to, cls: "cm-md-wikiraw" }); return false; }
          if (IMAGE_RE.test(l.target)) out.push({ t: "image", from: n.from, to: n.to, src: l.target, alt: l.label === l.target ? "" : l.label, wiki: true });
          else out.push({ t: "embed", from: n.from, to: n.to, target: l.target, label: l.label });
          return false;
        }
        case "FootnoteRef": {
          const label = text(n.from + 2, n.to - 1);
          const line = lineOf(n.from);
          if (n.from === line.from && state.sliceDoc(n.to, n.to + 1) === ":") return false; // a definition
          if (!onLines(n.from, n.to)) out.push({ t: "footref", from: n.from, to: n.to, label, text: footnotes.get(label) ?? "" });
          else out.push({ t: "mark", from: n.from, to: n.to, cls: "cm-md-footraw" });
          return false;
        }
        case "InlineMath": {
          if (!mathOn) return false;
          if (touches(n.from, n.to)) out.push({ t: "mark", from: n.from, to: n.to, cls: "cm-md-mathraw" });
          else out.push({ t: "math", from: n.from, to: n.to, tex: mathSource(text(n.from, n.to), false), display: false });
          return false;
        }
        case "BlockMath": {
          if (!mathOn) return false;
          const first = lineOf(n.from), last = lineOf(n.to);
          if (onLines(n.from, n.to)) {
            for (let ln = first.number; ln <= last.number; ln++) out.push({ t: "line", at: doc.line(ln).from, cls: `cm-md-mathsrc${ln === first.number ? " cm-md-mathsrc-first" : ""}${ln === last.number ? " cm-md-mathsrc-last" : ""}` });
          } else out.push({ t: "math", from: first.from, to: last.to, tex: mathSource(text(n.from, n.to), true), display: true });
          return false;
        }
        case "Escape":
          // "\$" reads as "$" once you leave the line.
          if (text(n.from, n.to) === "\\$" && !onLines(n.from, n.to)) out.push({ t: "hide", from: n.from, to: n.from + 1 });
          return false;
        case "URL":
          if (n.parent?.name !== "Link") out.push({ t: "mark", from: n.from, to: n.to, cls: "cm-md-link", attrs: { "data-href": text(n.from, n.to) } });
          return;
        case "WikiLink": {
          const l = parseWikiLink(text(n.from, n.to), n.from);
          if (!l) return false;
          if (onLines(n.from, n.to)) out.push({ t: "mark", from: n.from, to: n.to, cls: "cm-md-wikiraw" });
          else out.push({ t: "link", from: n.from, to: n.to, label: l.label, href: linkHref(l, opts.resolver), kind: l.kind });
          return false;
        }
        case "Task": {
          const marker = n.getChild("TaskMarker");
          if (!marker) return;
          const checked = /x/i.test(text(marker.from, marker.to));
          const item = n.parent;
          const listMark = item?.getChild("ListMark");
          const markerStart = listMark ? listMark.from : marker.from;
          if (checked) out.push({ t: "line", at: lineOf(n.from).from, cls: "cm-md-task-done" });
          out.push({ t: "line", at: lineOf(n.from).from, cls: "cm-md-task" });
          if (!touches(markerStart, marker.to)) {
            if (listMark) out.push({ t: "hide", from: listMark.from, to: marker.from });
            out.push({ t: "check", from: marker.from, to: marker.to, checked });
          }
          return;
        }
        case "ListItem": {
          const listMark = n.getChild("ListMark");
          const isTask = !!n.getChild("Task");
          if (listMark && !isTask && n.parent?.name === "BulletList" && !touches(listMark.from, listMark.to + 1)) {
            out.push({ t: "bullet", from: listMark.from, to: listMark.to });
          }
          return;
        }
        case "Blockquote": {
          const first = lineOf(n.from);
          const firstText = first.text.replace(/^\s*>\s?/, "");
          const callout = firstText.match(CALLOUT_RE);
          const last = lineOf(n.to);
          for (let ln = first.number; ln <= last.number; ln++) {
            const line = doc.line(ln);
            const base = callout ? `cm-md-callout cm-md-callout--${callout[1].toLowerCase()}` : "cm-md-quote";
            out.push({ t: "line", at: line.from, cls: `${base}${ln === first.number ? ` ${callout ? "cm-md-callout-first" : "cm-md-quote-first"}` : ""}${ln === last.number ? (callout ? " cm-md-callout-last" : " cm-md-quote-last") : ""}` });
          }
          if (callout && !onLines(first.from, first.to)) {
            const at = first.from + first.text.indexOf(callout[0]);
            out.push({ t: "callout", from: at, to: at + callout[0].length, kind: callout[1].toLowerCase() });
          }
          return;
        }
        case "QuoteMark": {
          if (!onLines(n.from, n.to)) out.push({ t: "hide", from: n.from, to: skipSpace(n.to, Math.min(n.to + 1, lineOf(n.from).to)) });
          return;
        }
        case "HorizontalRule":
          if (!onLines(n.from, n.to)) out.push({ t: "hr", from: n.from, to: n.to });
          return false;
        case "FencedCode": case "CodeBlock": {
          const first = lineOf(n.from), last = lineOf(n.to);
          const lang = n.getChild("CodeInfo");
          const away = !onLines(n.from, n.to);
          if (name === "FencedCode" && lang && /^mermaid$/i.test(text(lang.from, lang.to).trim()) && away) {
            const marks = children(n, "CodeMark");
            const closeLine = marks.length > 1 ? lineOf(marks[marks.length - 1].from).number : last.number + 1;
            const body: string[] = [];
            for (let ln = first.number + 1; ln < closeLine && ln <= last.number; ln++) body.push(doc.line(ln).text);
            const code = body.join("\n");
            out.push({ t: "mermaid", from: first.from, to: last.to, code });
            return false;
          }
          for (let ln = first.number; ln <= last.number; ln++) {
            out.push({ t: "line", at: doc.line(ln).from, cls: `cm-md-codeblock${ln === first.number ? " cm-md-codeblock-first" : ""}${ln === last.number ? " cm-md-codeblock-last" : ""}` });
          }
          // Fences show only while the cursor is in the block; the language stays as a label.
          for (const m of children(n, "CodeMark")) out.push(away ? { t: "hide", from: m.from, to: m.to } : { t: "mark", from: m.from, to: m.to, cls: "cm-md-fence" });
          if (lang) out.push({ t: "mark", from: lang.from, to: lang.to, cls: away ? "cm-md-fence cm-md-codelang" : "cm-md-fence" });
          return false;
        }
        case "Table": {
          const first = lineOf(n.from), last = lineOf(n.to);
          if (!onLines(n.from, n.to)) {
            const rows: string[][] = [];
            let align: Array<"left" | "center" | "right" | null> = [];
            for (let ln = first.number; ln <= last.number; ln++) {
              const cells = tableCells(doc.line(ln).text);
              if (ln === first.number + 1 && cells.every((c) => /^:?-+:?$/.test(c))) {
                align = cells.map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : null));
                continue;
              }
              rows.push(cells);
            }
            out.push({ t: "table", from: first.from, to: last.to, rows, align });
          } else {
            for (let ln = first.number; ln <= last.number; ln++) out.push({ t: "line", at: doc.line(ln).from, cls: "cm-md-table-src" });
          }
          return false;
        }
        default:
          return;
      }
    },
  });

  // Toggles: <details><summary>Title</summary> ... </details>, by lines (HTML isn't in the tree).
  const folded = foldedRanges(state);
  const stack: Array<{ line: number; title: string }> = [];
  for (let ln = 1; ln <= doc.lines; ln++) {
    const line = doc.line(ln);
    if (!line.text.includes("details")) continue;
    const open = line.text.match(DETAILS_OPEN_RE);
    if (open) { stack.push({ line: ln, title: open[1].trim() || "Details" }); continue; }
    if (DETAILS_CLOSE_RE.test(line.text) && stack.length) {
      const start = stack.pop()!;
      const head = doc.line(start.line);
      const foldFrom = head.to, foldTo = line.to;
      let isFolded = false;
      folded.between(foldFrom, foldTo, (a, b) => { if (a === foldFrom && b === foldTo) isFolded = true; });
      out.push({ t: "line", at: head.from, cls: "cm-md-toggle-head" });
      for (let b = start.line + 1; b < ln; b++) out.push({ t: "line", at: doc.line(b).from, cls: "cm-md-toggle-body" });
      out.push({ t: "line", at: line.from, cls: "cm-md-toggle-end" });
      if (!onLines(head.from, head.to)) out.push({ t: "toggle", from: head.from, to: head.to, title: start.title, folded: isFolded, foldFrom, foldTo });
      if (!onLines(line.from, line.to) && line.from < line.to) out.push({ t: "hide", from: line.from, to: line.to });
    }
  }

  // A typed line command waiting for Enter: "/todo send Nitin the deck".
  for (const r of state.selection.ranges) {
    const line = lineOf(r.head);
    const cmd = parseLineCommand(line.text);
    if (cmd && cmd.arg && opts.focused) {
      out.push({ t: "line", at: line.from, cls: "cm-md-command" });
      const hint = cmd.id === "decision" ? "Enter to add as a decision" : cmd.id === "date" ? "Enter for the date" : cmd.id === "waiting" ? "Enter to add to Waiting on" : "Enter to add to You owe";
      out.push({ t: "hint", at: line.to, text: hint });
    }
  }
  return out;
}
