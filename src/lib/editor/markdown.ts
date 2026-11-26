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

/** Everything the notes editor reads beyond CommonMark + GFM. */
export const NoteSyntax: MarkdownConfig[] = [WikiLink, Embed, Highlight, FootnoteRef];

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
