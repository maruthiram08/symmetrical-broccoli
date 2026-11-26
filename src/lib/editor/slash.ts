// Slash commands for the notes editor. Pure: the editor asks what to insert, and does it.
// Two shapes:
//  - insert commands (/heading, /quote, /table...) put Markdown in place right away;
//  - line commands (/todo, /owe, /waiting, /decision, /date) take the rest of the line, and
//    run on Enter: "/todo send Nitin the deck by Fri" becomes one of your items.
import { addDays, localDate } from "@/lib/brief/time";
import { parseCapture, parseDue, type ParseContext, type Parsed } from "@/lib/capture/parse";
import { formatWikiLink } from "./links";

export type SlashId =
  | "todo" | "owe" | "waiting" | "decision" | "date" | "person" | "link"
  | "heading" | "quote" | "callout" | "divider" | "table" | "toggle" | "checklist";

export interface SlashCommand {
  id: SlashId;
  label: string;
  hint: string;
  /** Extra words that find it ("h2" for heading). */
  aliases: string[];
  /** Takes the rest of the line and runs on Enter. */
  line: boolean;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { id: "todo", label: "To-do", hint: "Add something you owe, from one line", aliases: ["task", "item", "capture"], line: true },
  { id: "owe", label: "You owe", hint: "Something you promised someone", aliases: ["promise"], line: true },
  { id: "waiting", label: "Waiting on", hint: "Something someone owes you", aliases: ["wait", "theyowe"], line: true },
  { id: "decision", label: "Decision", hint: "Write down what was decided", aliases: ["decided"], line: true },
  { id: "date", label: "Date", hint: "Today's date, or /date fri", aliases: ["today", "day"], line: true },
  { id: "person", label: "Person", hint: "Link a person", aliases: ["mention", "people", "@"], line: false },
  { id: "link", label: "Link", hint: "Link a note, meeting, item or person", aliases: ["wiki", "page", "note"], line: false },
  { id: "heading", label: "Heading", hint: "Section heading", aliases: ["h2", "h1", "h3", "title"], line: false },
  { id: "quote", label: "Quote", hint: "Quoted text", aliases: ["blockquote"], line: false },
  { id: "callout", label: "Callout", hint: "A highlighted note block", aliases: ["note", "info", "warning", "tip"], line: false },
  { id: "divider", label: "Divider", hint: "A line across", aliases: ["hr", "rule", "line"], line: false },
  { id: "table", label: "Table", hint: "A 3 by 2 table", aliases: ["grid"], line: false },
  { id: "toggle", label: "Toggle", hint: "A block you can fold away", aliases: ["details", "collapse", "fold"], line: false },
  { id: "checklist", label: "Checklist", hint: "A list to tick off", aliases: ["check", "list", "tasks"], line: false },
];

const byId = new Map(SLASH_COMMANDS.map((c) => [c.id, c]));
export const slashCommand = (id: SlashId) => byId.get(id)!;

/** Commands matching what was typed after "/", best first (prefix of the id, then of an alias, then anywhere). */
export function filterCommands(query: string): SlashCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return SLASH_COMMANDS;
  const score = (c: SlashCommand) => {
    const words = [c.id, c.label.toLowerCase(), ...c.aliases];
    if (c.id.startsWith(q)) return 0;
    if (words.some((w) => w.startsWith(q))) return 1;
    if (words.some((w) => w.includes(q))) return 2;
    return 9;
  };
  return SLASH_COMMANDS.map((c) => [c, score(c)] as const).filter(([, s]) => s < 9).sort((a, b) => a[1] - b[1]).map(([c]) => c);
}

/**
 * A "/word" being typed, when the cursor is right after it at the start of a line (after any
 * list or quote marker) or after a space. `from` is where the "/" is, relative to the line.
 */
export function slashQueryAt(lineBefore: string): { from: number; query: string } | null {
  const m = lineBefore.match(/(^|\s)\/([a-z]*)$/i);
  if (!m) return null;
  const from = lineBefore.length - m[2].length - 1;
  // Not inside a URL or a path like "a/b".
  if (from > 0 && !/\s/.test(lineBefore[from - 1])) return null;
  return { from, query: m[2] };
}

export interface Insert {
  /** Text that replaces the "/query". */
  text: string;
  /** Cursor offset inside `text` after inserting (end when missing). */
  cursor?: number;
  /** Selection end, to select a placeholder. */
  selectTo?: number;
  /** The whole line is replaced (block commands), not just the "/query". */
  wholeLine?: boolean;
  /** Open link autocomplete after inserting. */
  complete?: boolean;
}

export const TABLE_TEMPLATE = "| Column | Column | Column |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |";

/** What picking a command from the menu inserts. Line commands leave "/id " to type after. */
export function insertFor(id: SlashId, opts: { today: string; lineRest?: string; prefix?: string } = { today: "" }): Insert {
  const rest = (opts.lineRest ?? "").trim();
  switch (id) {
    case "todo": case "owe": case "waiting": case "decision":
      return { text: `/${id} ` };
    case "date":
      return { text: formatWikiLink("day", opts.today) };
    case "person": return { text: "[[person:", complete: true };
    case "link": return { text: "[[", complete: true };
    case "heading": return { text: `## ${rest}`, wholeLine: true };
    case "quote": return { text: `> ${rest}`, wholeLine: true };
    case "callout": {
      const text = `> [!note] ${rest || "Note"}`;
      return rest ? { text, wholeLine: true } : { text, wholeLine: true, cursor: text.length - 4, selectTo: text.length };
    }
    case "divider": return { text: "---\n", wholeLine: true };
    case "table": return { text: TABLE_TEMPLATE, wholeLine: true, cursor: 2, selectTo: 8 };
    case "toggle": {
      const title = rest || "Details";
      const head = `<details><summary>${title}</summary>\n\n`;
      const text = `${head}\n\n</details>`;
      return rest ? { text, wholeLine: true, cursor: head.length } : { text, wholeLine: true, cursor: 18, selectTo: 18 + title.length };
    }
    case "checklist": return { text: `- [ ] ${rest}`, wholeLine: true };
  }
}

/** A typed line command: "/todo send Nitin the deck" (after any list marker). */
export function parseLineCommand(line: string): { id: "todo" | "owe" | "waiting" | "decision" | "date"; arg: string; indent: string } | null {
  const m = line.match(/^(\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?)?)\/(todo|owe|waiting|decision|date)(?:\s+(.*))?$/i);
  if (!m) return null;
  return { indent: m[1], id: m[2].toLowerCase() as "todo", arg: (m[3] ?? "").trim() };
}

/** "Fri 28 Nov" for a local date. */
export function shortDay(date: string): string {
  const [y, mo, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d));
  return `${t.toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" })} ${d} ${t.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" })}`;
}

/** What /todo, /owe and /waiting will add: the capture parser, with the kind forced for /owe and /waiting. */
export function parseItemCommand(id: "todo" | "owe" | "waiting", arg: string, ctx: ParseContext): Parsed | null {
  if (!arg.trim()) return null;
  const p = parseCapture(id === "waiting" && !/^(?:waiting|wait)\s*:/i.test(arg) ? `waiting: ${arg}` : arg, ctx);
  if (id === "owe" && p.kind !== "owe") {
    // "/owe Tarun the deck" is always yours, even when the words read like his.
    const own = parseCapture(`todo: ${arg}`, ctx);
    return { ...own, kind: "owe" };
  }
  return p;
}

/** The note line for an item just added: a checkbox, the item link, who and when. */
export function itemLine(p: Pick<Parsed, "kind" | "text" | "person" | "dueDate">, id: string, indent = ""): string {
  const bits = [formatWikiLink("item", id, p.text)];
  if (p.person) bits.push(`${p.kind === "waiting" ? "waiting on " : "for "}${formatWikiLink("person", p.person)}`);
  if (p.dueDate) bits.push(`due ${shortDay(p.dueDate)}`);
  const lead = /^\s*[-*+]\s+\[[ xX]\]\s+$/.test(indent) ? indent : `${indent.replace(/[-*+]\s+$/, "")}- [ ] `;
  return `${lead}${bits.join(" · ")}`;
}

/** /date with nothing, "fri", "tomorrow", "next week"...: a local date, or null when it isn't one. */
export function dateFor(arg: string, now: Date, timeZone: string): string | null {
  const today = localDate(now, timeZone);
  if (!arg.trim()) return today;
  if (/^yesterday$/i.test(arg.trim())) return addDays(today, -1);
  const { date, rest } = parseDue(arg, today);
  return date && !rest ? date : null;
}

/** The finished line for /decision and /date (no server call needed). */
export function localLine(cmd: { id: "decision" | "date"; arg: string; indent: string }, now: Date, timeZone: string): string | null {
  if (cmd.id === "decision") return cmd.arg ? `> [!decision] ${cmd.arg}` : null;
  const d = dateFor(cmd.arg, now, timeZone);
  return d ? `${cmd.indent}${formatWikiLink("day", d)}` : null;
}
