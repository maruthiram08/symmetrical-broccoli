// Wispr Flow's own action items, read from the Flow Summary markdown that get_meeting returns.
// The summary's next-steps section ("Next steps", "Action items", "Follow-ups"...) lists them as
// bullets or checkboxes, often with an owner in front ("Asha: send the deck", "Asha to send the
// deck") or grouped under an owner line ("**Asha**" followed by bullets). Pure and tolerant: a
// summary with no such section gives an empty list.

export interface WisprAction {
  /** The task, without bullet, checkbox or owner prefix. */
  text: string;
  /** Who Wispr says owns it, when the line says so. */
  owner: string | null;
  /** True for a ticked checkbox ("- [x] ..."). */
  done?: boolean;
}

/** Most items kept from one summary, and longest task text. */
export const MAX_ACTIONS = 40;
export const MAX_ACTION_CHARS = 300;

const SECTION = /^(?:key\s+|suggested\s+|open\s+|immediate\s+|agreed\s+)?(?:next\s*steps?|action\s*items?|actions?|follow[\s-]*ups?|to[\s-]*dos?|tasks?|next\s+actions?|commitments|owners?\s*(?:&|and)\s*next\s*steps?)\b(?:\s*(?:&|and|\/)\s*(?:next\s*steps?|action\s*items?|owners?|follow[\s-]*ups?|deadlines?|decisions?))?(?:\s*\([^)]*\))?\s*:?$/i;

/** Words that start a task line, so "Need to send it" is not an owner called "Need". */
const NOT_OWNER = new Set(
  "need needs plan plans want wants try tries going have has had agreed decided remember continue start begin ask reach make keep set get schedule follow send share review check confirm update create draft prepare finalize finalise book circle loop ping email call sync look figure work move add fix test write explore discuss consider aim hope expect please also then next who what when where why how this that these those it we they i you everyone all nobody someone somebody monday tuesday wednesday thursday friday saturday sunday today tomorrow tonight eod eow asap tbd january february march april may june july august september october november december by before after due".split(" "),
);

/** Other summary sections: a bold line with one of these closes the next-steps section rather than naming an owner. */
const OTHER_SECTION = /^(?:notes?|summary|overview|decisions?|key decisions|risks?|questions?|open questions|context|background|highlights?|recap|discussion|agenda|blockers?|takeaways?|key points|attendees|participants|details|updates?|topics?|timeline|metrics|parking lot|misc(?:ellaneous)?)$/i;

const BULLET = /^(\s*)(?:[-*+•▪◦‣]|\d{1,3}[.)])\s+(.*)$/;
const CHECKBOX = /^\[( |x|X)\]\s*(.*)$/;

/** Markdown emphasis, links, code and inline HTML removed. */
function plain(s: string): string {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_]([^*_]+)[*_](?=[^\w*]|$)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** A heading's level and text: "## Next steps", "**Next steps**", "Next steps:" (level 7 for the last two). */
function heading(line: string): { level: number; text: string } | null {
  const h = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
  if (h) return { level: h[1].length, text: plain(h[2]) };
  const b = line.match(/^\s*(?:\*\*|__)([^*_]{1,80}?)(?:\*\*|__)\s*:?\s*$/);
  if (b) return { level: 7, text: plain(b[1]) };
  return null;
}

const isSection = (t: string) => SECTION.test(t.replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+/u, "").trim());

/** "Asha", "Asha Rao", "Asha & Ravi", "Team", "@asha": short and name-like, not a verb. */
export function nameLike(s: string): boolean {
  const t = s.replace(/^@/, "").trim();
  if (!t || t.length > 40) return false;
  const parts = t.split(/\s*(?:&|\/|,|\band\b)\s*/i).filter(Boolean);
  if (!parts.length || parts.length > 4) return false;
  return parts.every((p) => {
    const words = p.split(/\s+/);
    if (words.length > 3) return false;
    if (NOT_OWNER.has(words[0].toLowerCase())) return false;
    return words.every((w) => /^[\p{Lu}][\p{L}'.-]*$/u.test(w) || /^(?:the|team|me)$/i.test(w));
  });
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const cleanOwner = (s: string) => s.replace(/^@/, "").replace(/\s+/g, " ").trim();

/** Splits an owner off a task line: "Asha: x", "Asha – x", "Asha to x", "Asha will x", "x (Asha)", "x — Owner: Asha". */
export function splitOwner(line: string): { text: string; owner: string | null } {
  const s = line.trim();
  let m = s.match(/^(?:owner\s*:\s*)?([^:–—]{1,40}?)\s*(?::|\s[–—-]\s)\s*(.+)$/i);
  if (m && nameLike(m[1])) return { owner: cleanOwner(m[1]), text: cap(m[2].trim()) };
  m = s.match(/^([^,;:]{1,40}?)\s+(?:to|will|should|must|needs to|is going to|'ll)\s+(\S.*)$/);
  if (m && nameLike(m[1])) return { owner: cleanOwner(m[1]), text: cap(m[2].trim()) };
  m = s.match(/^(.+?)\s*[–—-]\s*(?:owner|assigned to|assignee)\s*:?\s*([^()]{1,40})\.?$/i) ?? s.match(/^(.+?)\s*\((?:owner\s*:\s*|assigned to\s*:?\s*)?([^()]{1,40})\)\.?$/i);
  if (m && nameLike(m[2])) return { owner: cleanOwner(m[2]), text: m[1].trim() };
  return { text: s, owner: null };
}

/**
 * The action items in a Flow Summary's next-steps section(s), in order, de-duplicated.
 * A section runs until a heading at the same or a higher level. Inside it, a heading or bold line
 * that is just a name (or a bullet like "- **Asha:**" with nested bullets) sets the owner for the
 * lines below it.
 */
export function parseActionItems(summary: string | null | undefined): WisprAction[] {
  if (!summary?.trim()) return [];
  const lines = summary.replace(/\r\n?/g, "\n").split("\n");
  const out: WisprAction[] = [];
  const seen = new Set<string>();
  let inSection = false;
  let sectionLevel = 0;
  let groupOwner: { name: string; indent: number; level: number } | null = null;

  const push = (raw: string, owner: string | null, done: boolean) => {
    const sp = splitOwner(plain(raw));
    const text = sp.text.replace(/^[\s\-–—:]+/, "").trim().slice(0, MAX_ACTION_CHARS);
    if (text.length < 3 || out.length >= MAX_ACTIONS) return;
    const own = sp.owner ?? owner;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ text, owner: own, ...(done ? { done: true } : {}) });
  };

  for (const line of lines) {
    if (!line.trim()) continue;
    const h = BULLET.test(line) ? null : heading(line);
    const colon = !h && !BULLET.test(line) ? line.trim().match(/^(.{2,60}?):\s*$/) : null;
    const asHead = h ?? (colon ? { level: 7, text: plain(colon[1]) } : null);
    if (asHead) {
      if (isSection(asHead.text)) {
        inSection = true;
        sectionLevel = asHead.level;
        groupOwner = null;
        continue;
      }
      if (inSection && (asHead.level > sectionLevel || asHead.level === 7) && !OTHER_SECTION.test(asHead.text.replace(/:$/, "")) && nameLike(asHead.text.replace(/[:'’]s?$|’s$/g, "").replace(/:$/, ""))) {
        groupOwner = { name: cleanOwner(asHead.text.replace(/:$/, "")), indent: -1, level: asHead.level };
        continue;
      }
      if (inSection && asHead.level <= sectionLevel) { inSection = false; groupOwner = null; }
      else if (inSection && groupOwner && asHead.level <= groupOwner.level) groupOwner = null;
      continue;
    }
    if (!inSection) continue;
    const b = line.match(BULLET);
    if (!b) {
      // A plain paragraph inside the section: a task only when it reads like one with an owner.
      const p = plain(line);
      if (splitOwner(p).owner) push(p, groupOwner?.name ?? null, false);
      continue;
    }
    const indent = b[1].replace(/\t/g, "    ").length;
    if (groupOwner && groupOwner.indent >= 0 && indent <= groupOwner.indent) groupOwner = null;
    let body = b[2].trim();
    let done = false;
    const cb = body.match(CHECKBOX);
    if (cb) { done = cb[1] !== " "; body = cb[2]; }
    // "- **Asha:**" or "- Asha:" with nothing after it: an owner group for the nested bullets.
    const groupHead = plain(body).match(/^(.{1,40}?):?$/);
    if (groupHead && /:\s*(?:\*\*|__)?\s*$|^(?:\*\*|__).*(?:\*\*|__)$/.test(body) && nameLike(groupHead[1].replace(/:$/, ""))) {
      groupOwner = { name: cleanOwner(groupHead[1].replace(/:$/, "")), indent, level: 99 };
      continue;
    }
    push(body, groupOwner?.name ?? null, done);
  }
  return out;
}
