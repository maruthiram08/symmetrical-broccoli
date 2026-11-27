// The Markdown dialect of the notes editor: CommonMark + GFM (tables, task lists, strikethrough)
// plus [[wiki links]]. The editor edits the Markdown text itself, so a note is saved byte for byte
// as it was typed; this file only reads it (for the live preview, links and backlinks).
import { GFM, parser as baseParser, type MarkdownConfig } from "@lezer/markdown";

/** `[[`, then anything but brackets and newlines, then `]]`. */
export const WikiLink: MarkdownConfig = {
  defineNodes: [{ name: "WikiLink" }],
  parseInline: [
    {
      name: "WikiLink",
      before: "Link",
      parse(cx, next, pos) {
        if (next !== 91 /* [ */ || cx.char(pos + 1) !== 91) return -1;
        for (let i = pos + 2; i < cx.end; i++) {
          const c = cx.char(i);
          if (c === 10 || c === 91) return -1;
          if (c === 93 /* ] */) {
            if (cx.char(i + 1) !== 93 || i === pos + 2) return -1;
            return cx.addElement(cx.elt("WikiLink", pos, i + 2));
          }
        }
        return -1;
      },
    },
  ],
};

/** `![[Note]]` / `![[picture.png]]`: an embed (Obsidian style). Holds a WikiLink, so backlinks count it. */
export const Embed: MarkdownConfig = {
  defineNodes: [{ name: "Embed" }],
  parseInline: [
    {
      name: "Embed",
      before: "Image",
      parse(cx, next, pos) {
        if (next !== 33 /* ! */ || cx.char(pos + 1) !== 91 || cx.char(pos + 2) !== 91) return -1;
        for (let i = pos + 3; i < cx.end; i++) {
          const c = cx.char(i);
          if (c === 10 || c === 91) return -1;
          if (c === 93) {
            if (cx.char(i + 1) !== 93 || i === pos + 3) return -1;
            return cx.addElement(cx.elt("Embed", pos, i + 2, [cx.elt("WikiLink", pos + 1, i + 2)]));
          }
        }
        return -1;
      },
    },
  ],
};

const HighlightDelim = { resolve: "Highlight", mark: "HighlightMark" };
/** `==highlighted==`, as in Obsidian and Octarine. */
export const Highlight: MarkdownConfig = {
  defineNodes: [{ name: "Highlight" }, { name: "HighlightMark" }],
  parseInline: [
    {
      name: "Highlight",
      after: "Emphasis",
      parse(cx, next, pos) {
        if (next !== 61 /* = */ || cx.char(pos + 1) !== 61 || cx.char(pos + 2) === 61) return -1;
        const before = cx.slice(pos - 1, pos), after = cx.slice(pos + 2, pos + 3);
        const sBefore = /\s|^$/.test(before), sAfter = /\s|^$/.test(after);
        return cx.addDelimiter(HighlightDelim, pos, pos + 2, !sAfter, !sBefore);
      },
    },
  ],
};

/** `[^1]`: a footnote reference. Its definition is a line "[^1]: text". */
export const FootnoteRef: MarkdownConfig = {
  defineNodes: [{ name: "FootnoteRef" }],
  parseInline: [
    {
      name: "FootnoteRef",
      before: "Link",
      parse(cx, next, pos) {
        if (next !== 91 || cx.char(pos + 1) !== 94 /* ^ */) return -1;
        for (let i = pos + 2; i < cx.end && i < pos + 64; i++) {
          const c = cx.char(i);
          if (c === 10 || c === 32 || c === 9 || c === 91 || c === 94) return -1;
          if (c === 93) return i === pos + 2 ? -1 : cx.addElement(cx.elt("FootnoteRef", pos, i + 1));
        }
        return -1;
      },
    },
  ],
};

const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;
const isDigit = (c: number) => c >= 48 && c <= 57;
const isWord = (c: number) => isDigit(c) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);

/**
 * Inline math: `$x^2$` (and `$$x$$` mid-line). Pandoc's rules keep money out: no space just inside
 * the dollars, no digit right after the closing one, and never after a letter or digit ("US$5").
 * So "$50 and $60" and "costs $5, or $10" stay text. Never runs past the end of a line.
 */
export const InlineMath: MarkdownConfig = {
  defineNodes: [{ name: "InlineMath" }, { name: "MathMark" }],
  parseInline: [
    {
      name: "InlineMath",
      before: "Emphasis",
      parse(cx, next, pos) {
        if (next !== 36 /* $ */) return -1;
        if (pos > cx.offset && isWord(cx.char(pos - 1))) return -1;
        const double = cx.char(pos + 1) === 36;
        const open = double ? 2 : 1;
        const first = cx.char(pos + open);
        if (first < 0 || isSpace(first) || first === 36) return -1;
        for (let i = pos + open; i < cx.end; i++) {
          const c = cx.char(i);
          if (c === 10) return -1;
          if (c === 92 /* \ */) { i++; continue; }
          if (c !== 36) continue;
          if (double) {
            if (cx.char(i + 1) !== 36) return -1;
            if (isSpace(cx.char(i - 1))) return -1;
            return cx.addElement(cx.elt("InlineMath", pos, i + 2, [cx.elt("MathMark", pos, pos + 2), cx.elt("MathMark", i, i + 2)]));
          }
          if (isSpace(cx.char(i - 1)) || isDigit(cx.char(i + 1))) return -1;
          return cx.addElement(cx.elt("InlineMath", pos, i + 1, [cx.elt("MathMark", pos, pos + 1), cx.elt("MathMark", i, i + 1)]));
        }
        return -1;
      },
    },
  ],
};

const BLANK = /^[ \t>]*$/;
const CLOSES = /\$\$[ \t]*$/;

interface Lookahead { absoluteLineEnd: number; stack: unknown[]; scanLine(pos: number): { text: string; end: number } }

/** Display math: a block opened by "$$" at the start of a line and closed by a line ending in "$$". */
export const BlockMath: MarkdownConfig = {
  defineNodes: [{ name: "BlockMath", block: true }],
  parseBlock: [
    {
      name: "BlockMath",
      before: "FencedCode",
      parse(cx, line) {
        if (line.next !== 36 || line.text.charCodeAt(line.pos + 1) !== 36) return false;
        const from = cx.lineStart + line.pos;
        const rest = line.text.slice(line.pos + 2);
        const oneLine = rest.trim().length >= 2 && CLOSES.test(rest);
        if (!oneLine) {
          // Only a block with its closing "$$" before a blank line is math; a lone "$$" stays text.
          const la = cx as unknown as Lookahead;
          let at = la.absoluteLineEnd + 1, closed = false;
          for (let n = 0; n < 400; n++) {
            const r = la.scanLine(at);
            const text = r.text, end = r.end;
            if (BLANK.test(text)) break;
            if (CLOSES.test(text)) { closed = true; break; }
            at = end + 1;
          }
          if (!closed) return false;
        }
        const marks = [...line.markers];
        let to = cx.lineStart + line.text.length;
        if (!oneLine) {
          const inside = () => (line as unknown as { depth: number }).depth >= (cx as unknown as Lookahead).stack.length;
          while (cx.nextLine() && inside()) {
            marks.push(...line.markers);
            to = cx.lineStart + line.text.length;
            if (CLOSES.test(line.text.slice(line.pos))) break;
          }
        }
        cx.addElement(cx.elt("BlockMath", from, to, marks));
        if (to === cx.lineStart + line.text.length) cx.nextLine();
        return true;
      },
    },
  ],
};

/** Everything the notes editor reads beyond CommonMark + GFM. */
export const NoteSyntax: MarkdownConfig[] = [WikiLink, Embed, Highlight, FootnoteRef, InlineMath, BlockMath];

/** "[^1]: the note" at the start of a line. */
export const FOOTNOTE_DEF_RE = /^\[\^([^\]\s^]+)\]:[ \t]?/;

/** The parser used by the editor and by backlinks. */
export const notesParser = baseParser.configure([GFM, ...NoteSyntax]);

/** The line separator a file uses, so the editor writes it back the same way. */
export function lineSeparatorOf(text: string): "\n" | "\r\n" {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  if (!crlf) return "\n";
  const lf = (text.match(/\n/g) ?? []).length;
  // Mixed endings: a file that is mostly CRLF stays CRLF.
  return crlf * 2 >= lf ? "\r\n" : "\n";
}
