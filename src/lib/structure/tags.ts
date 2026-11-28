// Tags: `#tag` and `#nested/tag` in notes, a `tags:` property, and tags on items. Finding tags
// in Markdown needs the parser (code and links are skipped); everything else is in tag-core.ts.
import { notesParser } from "@/lib/editor/markdown";
import { normalizeTag, TAG_IN_TEXT } from "./tag-core";

export * from "./tag-core";

export interface TagRange { from: number; to: number; tag: string }

const SKIP = new Set(["InlineCode", "FencedCode", "CodeBlock", "URL", "Link", "Autolink", "WikiLink", "HTMLBlock", "HTMLTag", "CommentBlock", "Comment", "ProcessingInstructionBlock"]);

/** Where each #tag is in a Markdown text (offsets of "#..."), skipping code, links and HTML. */
export function findTagRanges(md: string): TagRange[] {
  if (!md.includes("#")) return [];
  const skip: Array<[number, number]> = [];
  notesParser.parse(md).iterate({
    enter(n) {
      if (SKIP.has(n.name)) { skip.push([n.from, n.to]); return false; }
      return undefined;
    },
  });
  const out: TagRange[] = [];
  for (const m of md.matchAll(TAG_IN_TEXT)) {
    const from = (m.index ?? 0) + m[1].length;
    const to = from + 1 + m[2].length;
    if (skip.some(([a, b]) => from >= a && from < b)) continue;
    const tag = normalizeTag(m[2]);
    if (tag) out.push({ from, to, tag });
  }
  return out;
}

/** Every tag in a text, once each, in order of first use. */
export function findTags(md: string): string[] {
  return [...new Set(findTagRanges(md).map((r) => r.tag))];
}

