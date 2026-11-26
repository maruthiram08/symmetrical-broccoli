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

/** The parser used by the editor and by backlinks. */
export const notesParser = baseParser.configure([GFM, WikiLink]);

/** The line separator a file uses, so the editor writes it back the same way. */
export function lineSeparatorOf(text: string): "\n" | "\r\n" {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  if (!crlf) return "\n";
  const lf = (text.match(/\n/g) ?? []).length;
  // Mixed endings: a file that is mostly CRLF stays CRLF.
  return crlf * 2 >= lf ? "\r\n" : "\n";
}
