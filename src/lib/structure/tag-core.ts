// Tags without the Markdown parser (safe for any client bundle: quick capture, views, ⌘K).
// Tags are compared in lower case; `#a/b` also counts under `a`. Pure: no files, no store.

/** A tag's characters: letters, digits, _ - and / between parts. At least one non-digit. */
export const TAG_BODY = "[\\p{L}\\p{N}_][\\p{L}\\p{N}_\\-]*(?:\\/[\\p{L}\\p{N}_][\\p{L}\\p{N}_\\-]*)*";
export const TAG_IN_TEXT = new RegExp(`(^|[\\s(,;:!?"'\\u201c])#(${TAG_BODY})`, "gu");

/** "#Q4/Launch" or "Q4/Launch" -> "q4/launch"; null when it isn't a valid tag. */
export function normalizeTag(raw: string): string | null {
  const t = raw.trim().replace(/^#/, "").replace(/\/+$/, "").toLowerCase();
  if (!t || !new RegExp(`^${TAG_BODY}$`, "u").test(t) || /^\d+$/.test(t.split("/")[0])) return null;
  return t;
}

/** Tags from a `tags:` (or `tag:`) property: a list, or one string of space/comma separated tags. */
export function propertyTags(value: unknown): string[] {
  const parts = Array.isArray(value) ? value.map(String) : typeof value === "string" ? value.split(/[\s,]+/) : [];
  return [...new Set(parts.map(normalizeTag).filter((t): t is string => !!t))];
}

/** "a/b/c" -> ["a", "a/b", "a/b/c"]. */
export function tagAncestors(tag: string): string[] {
  const parts = tag.split("/");
  return parts.map((_p, i) => parts.slice(0, i + 1).join("/"));
}

export interface TagNode {
  /** Full path: "project/launch". */
  tag: string;
  /** Last part: "launch". */
  name: string;
  /** Notes and items tagged with this tag or one under it. */
  notes: number;
  items: number;
  children: TagNode[];
}

/** A tree of tags with counts. `uses` lists the tags of each note and each item. */
export function tagTree(uses: { notes: string[][]; items: string[][] }): TagNode[] {
  const nodes = new Map<string, TagNode>();
  const node = (tag: string): TagNode => {
    let n = nodes.get(tag);
    if (!n) nodes.set(tag, (n = { tag, name: tag.split("/").pop()!, notes: 0, items: 0, children: [] }));
    return n;
  };
  const count = (lists: string[][], key: "notes" | "items") => {
    for (const tags of lists) {
      const all = new Set(tags.flatMap(tagAncestors));
      for (const t of all) node(t)[key]++;
    }
  };
  count(uses.notes, "notes");
  count(uses.items, "items");
  const roots: TagNode[] = [];
  for (const n of [...nodes.values()].sort((a, b) => a.tag.localeCompare(b.tag))) {
    const parent = n.tag.includes("/") ? nodes.get(n.tag.slice(0, n.tag.lastIndexOf("/"))) : undefined;
    (parent ? parent.children : roots).push(n);
  }
  return roots;
}

/** Flat list of every tag (for Cmd+K and pickers), with total counts, most used first. */
export function flatTags(tree: TagNode[]): Array<{ tag: string; count: number }> {
  const out: Array<{ tag: string; count: number }> = [];
  const walk = (ns: TagNode[]) => { for (const n of ns) { out.push({ tag: n.tag, count: n.notes + n.items }); walk(n.children); } };
  walk(tree);
  return out.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/**
 * Quick capture's extras: `#tag` words and one `+project` word are taken out of the line, so the
 * rest reads as before. "send Nitin the deck #launch +q4-plan by Fri".
 */
export function captureTokens(line: string): { rest: string; tags: string[]; project: string | null } {
  const tags: string[] = [];
  let project: string | null = null;
  let rest = line.replace(new RegExp(`(^|\\s)#(${TAG_BODY})(?=\\s|$)`, "gu"), (all, lead: string, t: string) => {
    const n = normalizeTag(t);
    if (!n) return all;
    if (!tags.includes(n)) tags.push(n);
    return lead;
  });
  rest = rest.replace(/(^|\s)\+([\p{L}\p{N}][\p{L}\p{N}_-]*)(?=\s|$)/gu, (all, lead: string, p: string) => {
    if (/^\d+$/.test(p)) return all; // "+1" is not a project
    project ??= p;
    return lead;
  });
  return { rest: rest.replace(/\s+/g, " ").trim(), tags, project };
}

/** A list of tags typed by hand ("launch, q4/plan #ops") as clean tags. */
export function parseTagList(input: string): string[] {
  return [...new Set(input.split(/[\s,]+/).map(normalizeTag).filter((t): t is string => !!t))];
}
/** The tag's page: /tags/launch/web. */
export const tagHref = (tag: string) => `/tags/${tag.split("/").map(encodeURIComponent).join("/")}`;

/** True when `tag` is `filter` or nested under it ("a/b" matches "a"). */
export const tagMatches = (tag: string, filter: string) => tag === filter || tag.startsWith(`${filter}/`);

export const hasTag = (tags: readonly string[] | undefined, filter: string) => !!tags?.some((t) => tagMatches(t, filter));

/**
 * #tags in Markdown without the parser: code blocks, inline code, links and URLs are cut out
 * first. Close to findTags (tags.ts) and cheap enough for the browser on every keystroke.
 */
export function findTagsLite(md: string): string[] {
  if (!md.includes("#")) return [];
  const text = md
    .replace(/^(\s*)(```|~~~)[\s\S]*?^\1\2[^\n]*$/gm, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/\[\[[^\]\n]*\]\]/g, " ")
    .replace(/\]\([^)\n]*\)/g, "] ")
    .replace(/<[^>\n]+>/g, " ")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, " ");
  const out: string[] = [];
  for (const m of text.matchAll(TAG_IN_TEXT)) {
    const t = normalizeTag(m[2]);
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}
