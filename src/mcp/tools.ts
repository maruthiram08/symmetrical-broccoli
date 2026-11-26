// The MCP tools: what Claude Desktop / Claude Code can ask about your brief.
// Each tool re-reads state.json (FileStore reloads when its mtime changes) and answers in plain
// text. Nothing here calls the Anthropic API or Wispr Flow; the only write is mark_item.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildBrief } from "@/lib/brief/build";
import { dueLabel, formatTime, lateLabel, localDayBounds } from "@/lib/brief/time";
import { belongsTo, findPerson, groupNames, listPeople, normalizeName, personDetail, type PersonGroup } from "@/lib/people";
import { buildIndex, search as searchIndex, type SearchHit } from "@/lib/search";
import type { BriefLine, Item, ItemKind, Meeting, User } from "@/lib/types";
import type { Store } from "@/server/store";

export interface ToolContext {
  /** A FileStore on state.json (any Store works). Its reads reload the file when it changed on disk. */
  store: Store;
  now?: () => Date;
}

const NOT_SET_UP = "Daily brief isn't set up yet: open http://localhost:4242 and save your name first.";

interface Snapshot {
  user: User;
  items: Item[];
  meetings: Meeting[];
  byId: Map<string, Meeting>;
  now: Date;
}

/** Fresh read of everything for the one local user, or null before setup. */
async function snapshot(ctx: ToolContext): Promise<Snapshot | null> {
  const user = (await ctx.store.listUsers())[0];
  if (!user) return null;
  const [items, meetings] = await Promise.all([
    ctx.store.listItems(user.id),
    ctx.store.listMeetingsBetween(user.id, "0000", "9999"),
  ]);
  return { user, items, meetings, byId: new Map(meetings.map((m) => [m.id, m])), now: (ctx.now ?? (() => new Date()))() };
}

// ---------- formatting ----------

const KIND_LABEL: Record<ItemKind, string> = { owe: "You owe", waiting: "Waiting on", decision: "Decision" };
const SECTION: Record<ItemKind, string> = { owe: "You owe", waiting: "Waiting on", decision: "Decisions" };

function day(iso: string, tz: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: tz });
}

function dueText(i: Item, s: Snapshot): string | null {
  if (!i.dueAt || i.kind === "decision") return null;
  const tz = s.user.timeZone;
  const when = `${dueLabel(i.dueAt, s.now, tz)} ${formatTime(i.dueAt, tz)}`;
  const late = i.status === "open" && Date.parse(i.dueAt) < s.now.getTime()
    ? lateLabel(Math.floor((s.now.getTime() - Date.parse(i.dueAt)) / 60000)) : null;
  return late ? `due ${day(i.dueAt, tz)} (${late})` : `due ${when}`;
}

/**
 * One item, two or three lines:
 *   [id] You owe · Nitin · due Tomorrow 6:00 PM
 *     Send Nitin the final banner text
 *     Standup, 25 Nov 2026 · "I'll send it tonight"
 */
export function formatItem(i: Item, s: Snapshot): string {
  const tz = s.user.timeZone;
  const status = i.status === "open" ? "" : i.status === "done" ? " (done)" : i.status === "inbox" ? " (in the Inbox)" : " (marked wrong)";
  const head = [`[${i.id}] ${KIND_LABEL[i.kind]}${status}`, i.person, dueText(i, s)].filter(Boolean).join(" · ");
  const m = s.byId.get(i.meetingId);
  const src = m ? `${m.title}, ${day(m.startedAt, tz)}` : "a meeting";
  const out = [head, `  ${i.text}`, i.source === "manual" ? `  Added by you${i.note ? ` · ${i.note}` : ""}` : `  ${src} · "${i.quote}"`];
  if (i.status === "done") {
    const cm = i.closedByMeetingId ? s.byId.get(i.closedByMeetingId) : undefined;
    if (i.closeQuote) out.push(`  Closed in ${cm ? `${cm.title}, ${day(cm.startedAt, tz)}` : "a later meeting"}: "${i.closeQuote}"`);
    else out.push(`  Marked done by you${i.closedAt ? `, ${day(i.closedAt, tz)}` : ""}`);
  }
  return out.join("\n");
}

function list(title: string, items: Item[], s: Snapshot, empty?: string): string {
  if (!items.length) return empty ? `## ${title}\n${empty}` : "";
  return `## ${title} (${items.length})\n${items.map((i) => formatItem(i, s)).join("\n\n")}`;
}

const join = (...parts: string[]) => parts.filter(Boolean).join("\n\n");

const started = (i: Item, s: Snapshot) => s.byId.get(i.meetingId)?.startedAt ?? i.createdAt;
/** Overdue first, then soonest due, then oldest. */
const byUrgency = (s: Snapshot) => (a: Item, b: Item) =>
  (a.dueAt ? Date.parse(a.dueAt) : Infinity) - (b.dueAt ? Date.parse(b.dueAt) : Infinity) ||
  started(a, s).localeCompare(started(b, s));
const newestFirst = (s: Snapshot) => (a: Item, b: Item) => started(b, s).localeCompare(started(a, s));

// ---------- people ----------

const selfNames = (u: User) => [u.name, ...u.aliases];

/**
 * The /people match first (any spelling's slug, "nitin-k" finds Nitin K), then a looser one:
 * a person whose name has a word starting with every word asked ("tarun" finds "Tarun Mehta").
 * Returns one person, or the candidates when it's ambiguous.
 */
export function resolvePerson(name: string, s: Snapshot): { person: PersonGroup } | { candidates: string[] } {
  const input = { items: s.items, meetings: s.meetings, now: s.now, self: selfNames(s.user) };
  const exact = findPerson(name, input);
  if (exact) return { person: exact };
  const want = normalizeName(name).split(" ").filter(Boolean);
  if (!want.length) return { candidates: [] };
  const groups = groupNames(s.items.filter((i) => i.status !== "wrong").map((i) => i.person ?? "").filter(Boolean), selfNames(s.user));
  const hits = groups.filter((g) =>
    g.keys.some((k) => { const ws = k.split(" "); return want.every((w) => ws.some((x) => x.startsWith(w))); }));
  if (hits.length === 1) return { person: hits[0] };
  return { candidates: hits.map((g) => g.name) };
}

function noSuchPerson(name: string, candidates: string[], s: Snapshot): string {
  if (candidates.length) return `"${name}" could be: ${candidates.join(", ")}. Ask again with the full name.`;
  const people = listPeople({ items: s.items, meetings: s.meetings, now: s.now, self: selfNames(s.user) }).slice(0, 30).map((p) => p.name);
  return `Nobody called "${name}" in your meetings.${people.length ? ` People: ${people.join(", ")}.` : ""}`;
}

// ---------- tools ----------

export const Kind = z.enum(["owe", "waiting", "decision", "all"]);

export async function listOpen(ctx: ToolContext, args: { kind?: z.infer<typeof Kind>; person?: string; limit?: number }): Promise<string> {
  const s = await snapshot(ctx);
  if (!s) return NOT_SET_UP;
  let open = s.items.filter((i) => i.status === "open");
  if (args.kind && args.kind !== "all") open = open.filter((i) => i.kind === args.kind);
  let who = "";
  if (args.person) {
    const r = resolvePerson(args.person, s);
    if (!("person" in r)) return noSuchPerson(args.person, r.candidates, s);
    open = open.filter((i) => belongsTo(r.person, i.person));
    who = ` with ${r.person.name}`;
  }
  const limit = args.limit ?? 50;
  const kinds: ItemKind[] = args.kind && args.kind !== "all" ? [args.kind] : ["owe", "waiting", "decision"];
  const sections = kinds.map((k) => {
    const all = open.filter((i) => i.kind === k).sort(k === "decision" ? newestFirst(s) : byUrgency(s));
    const shown = all.slice(0, limit);
    const more = all.length > shown.length ? `\n\n…and ${all.length - shown.length} more (raise limit to see them).` : "";
    return shown.length ? list(SECTION[k], shown, s) + more : "";
  });
  return join(...sections) || `Nothing open${who}.`;
}

export async function person(ctx: ToolContext, args: { name: string; recent_days?: number }): Promise<string> {
  const s = await snapshot(ctx);
  if (!s) return NOT_SET_UP;
  const r = resolvePerson(args.name, s);
  if (!("person" in r)) return noSuchPerson(args.name, r.candidates, s);
  const d = personDetail(r.person.slug, { items: s.items, meetings: s.meetings, now: s.now, self: selfNames(s.user) }, args.recent_days ?? 30)!;
  const p = d.person;
  const aka = p.spellings.filter((x) => normalizeName(x) !== normalizeName(p.name));
  const last = d.meetings[0];
  const head = [
    `# ${p.name}${aka.length ? ` (also written ${aka.join(", ")})` : ""}`,
    `You owe ${d.youOwe.length} · they owe you ${d.waitingOn.length} · ${d.summary.overdue} overdue · ${d.meetings.length} meetings together${last ? `, last ${last.title} on ${day(last.startedAt, s.user.timeZone)}` : ""}`,
  ].join("\n");
  return join(
    head,
    list("You owe", d.youOwe, s, `Nothing owed to ${p.name}.`),
    list("Waiting on", d.waitingOn, s, `${p.name} owes you nothing.`),
    list(`Closed in the last ${args.recent_days ?? 30} days`, d.closed, s),
    list("Decisions from meetings together", d.decisions.slice(0, 15), s),
  );
}

export async function searchItems(ctx: ToolContext, args: { query: string; include_closed?: boolean; limit?: number }): Promise<string> {
  const s = await snapshot(ctx);
  if (!s) return NOT_SET_UP;
  const limit = args.limit ?? 20;
  const hits = searchIndex(buildIndex(s.items, s.meetings), args.query.slice(0, 200), 500);
  const byId = new Map(s.items.map((i) => [i.id, i]));
  const found = hits
    .filter((h): h is Extract<SearchHit, { type: "item" }> => h.type === "item")
    .filter((h) => args.include_closed || h.status === "open")
    .slice(0, limit)
    .map((h) => byId.get(h.id)!);
  const met = hits.filter((h): h is Extract<SearchHit, { type: "meeting" }> => h.type === "meeting").slice(0, 5);
  const meetingsText = met.length
    ? `## Meetings\n${met.map((m) => `- ${m.title}, ${day(m.at, s.user.timeZone)}${m.participants.length ? ` (with ${m.participants.join(", ")})` : ""}`).join("\n")}`
    : "";
  if (!found.length && !met.length) {
    return `Nothing matches "${args.query}"${args.include_closed ? "" : " in open items (try include_closed: true)"}.`;
  }
  return join(
    list(args.include_closed ? "Items, best match first" : "Open items, best match first", found, s,
      args.include_closed ? "No items match." : "No open items match (try include_closed: true)."),
    meetingsText,
  );
}

export async function decisions(ctx: ToolContext, args: { since?: string; query?: string; limit?: number }): Promise<string> {
  const s = await snapshot(ctx);
  if (!s) return NOT_SET_UP;
  let ds = s.items.filter((i) => i.kind === "decision" && i.status !== "wrong");
  if (args.since) {
    const from = /^\d{4}-\d{2}-\d{2}$/.test(args.since) ? localDayBounds(args.since, s.user.timeZone).startIso : new Date(args.since).toISOString();
    ds = ds.filter((i) => started(i, s) >= from);
  }
  if (args.query?.trim()) {
    const order = new Map(
      searchIndex(buildIndex(ds, s.meetings), args.query.slice(0, 200), 500)
        .filter((h) => h.type === "item").map((h, n) => [h.id, n]),
    );
    ds = ds.filter((i) => order.has(i.id)).sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  } else {
    ds.sort(newestFirst(s));
  }
  const limit = args.limit ?? 30;
  const shown = ds.slice(0, limit);
  const more = ds.length > shown.length ? `\n\n…and ${ds.length - shown.length} more.` : "";
  const what = [args.query ? `about "${args.query}"` : "", args.since ? `since ${args.since}` : ""].filter(Boolean).join(" ");
  return shown.length
    ? list(`Decisions${what ? ` ${what}` : ""}${args.query ? ", best match first" : ", newest first"}`, shown, s) + more
    : `No decisions${what ? ` ${what}` : ""}.`;
}

export async function today(ctx: ToolContext): Promise<string> {
  const s = await snapshot(ctx);
  if (!s) return NOT_SET_UP;
  const b = await buildBrief(ctx.store, s.user, s.now);
  const byId = new Map(s.items.map((i) => [i.id, i]));
  const items = (ls: BriefLine[]) => ls.map((l) => byId.get(l.itemId)).filter((i): i is Item => !!i);
  const closed = b.closedToday.map((c) => byId.get(c.itemId)).filter((i): i is Item => !!i);
  const n = (k: number, one: string) => `${k} ${one}${k === 1 ? "" : "s"}`;
  return join(
    `# ${b.dateLabel}\n${b.meetingCount ? `From ${n(b.meetingCount, "meeting")} today.` : "No meetings yet today."} ${b.subject}.`,
    list("You owe", items(b.youOwe), s, b.meetingCount ? "Nothing owed. Go home." : "Nothing owed today."),
    list("Waiting on", items(b.waitingOn), s, "Nobody owes you anything today."),
    list("Decisions", items(b.decisions), s, "No decisions today."),
    list("Closed today", closed, s),
    b.stillOpenCount
      ? list(`Still open from before (showing ${b.stillOpen.length} of ${b.stillOpenCount}; list_open shows all)`, items(b.stillOpen), s)
      : "",
  );
}

export async function markItem(ctx: ToolContext, args: { id: string; status: "done" | "wrong" | "open" }): Promise<{ text: string; isError?: boolean }> {
  const s = await snapshot(ctx);
  if (!s) return { text: NOT_SET_UP, isError: true };
  const id = args.id.trim().replace(/^\[|\]$/g, "");
  const matches = s.items.filter((i) => i.id === id || (id.length >= 6 && i.id.startsWith(id)));
  if (matches.length !== 1) {
    return { text: matches.length ? `"${id}" matches ${matches.length} items; use the full id.` : `No item with id "${id}". Ids are shown in [brackets] by the other tools.`, isError: true };
  }
  const item = matches[0];
  if (item.status === args.status) return { text: `Already ${args.status}:\n${formatItem(item, s)}` };
  // Same call the Done / Wrong / Undo buttons make (src/app/actions.ts setStatus): FileStore
  // reloads state.json, applies the change and writes it atomically. The web app sees it on its
  // next read, because FileStore reloads whenever the file's mtime changes.
  await ctx.store.setItemStatus(item.id, args.status, s.now.toISOString());
  const after = await snapshot(ctx);
  const updated = after?.items.find((i) => i.id === item.id);
  if (!after || !updated || updated.status !== args.status) return { text: "The change didn't stick; try again.", isError: true };
  const verb = args.status === "done" ? "Marked done" : args.status === "wrong" ? "Marked wrong (hidden from the brief)" : "Reopened";
  return { text: `${verb}:\n${formatItem(updated, after)}` };
}

// ---------- server ----------

const text = (t: string, isError?: boolean) => ({ content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) });
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const limitArg = (n: number, max: number) => z.number().int().min(1).max(max).optional().describe(`Most items to return per section (default ${n}).`);

/** All six tools on one McpServer. The caller connects a transport (stdio in server.ts, in-memory in tests). */
export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: "daily-brief", version: "0.1.0" },
    {
      instructions:
        "Daily brief tracks promises from the user's meetings: what they owe others (owe), what others owe them (waiting), " +
        "and decisions. Every item has an id in [brackets], the person, the meeting it came from and the exact quote. " +
        "Quote the evidence when answering. Use mark_item only when the user asks to close, reopen or dismiss an item.",
    },
  );

  server.registerTool("list_open", {
    title: "List open items",
    description:
      "Everything still open: what the user owes (owe), what they're waiting on from others (waiting), and decisions. " +
      "Optionally only one kind and/or one person (fuzzy name match). Owe/waiting are sorted by due date (overdue first); decisions newest first.",
    inputSchema: {
      kind: Kind.optional().describe("owe = user promised it; waiting = someone owes the user; decision; all (default)."),
      person: z.string().max(80).optional().describe("Only items involving this person, e.g. \"Tarun\"."),
      limit: limitArg(50, 500),
    },
    annotations: READ_ONLY,
  }, async (a) => text(await listOpen(ctx, a)));

  server.registerTool("person", {
    title: "One person",
    description:
      "Everything with one person: what the user owes them, what they owe the user, items closed recently, and decisions from meetings together. " +
      "Use for \"what do I owe Tarun?\" or \"what is Nitin waiting on?\". Name matching is fuzzy (first name or part of a name works).",
    inputSchema: {
      name: z.string().min(1).max(80).describe("The person's name or part of it."),
      recent_days: z.number().int().min(1).max(365).optional().describe("How far back to show closed items (default 30)."),
    },
    annotations: READ_ONLY,
  }, async (a) => text(await person(ctx, a)));

  server.registerTool("search", {
    title: "Search",
    description:
      "Search item text, quotes, people and meeting titles. Words match at word starts (\"ban\" finds \"banner\"). " +
      "Open items only unless include_closed is true. Also lists matching meetings.",
    inputSchema: {
      query: z.string().min(1).max(200),
      include_closed: z.boolean().optional().describe("Include items already done (default false)."),
      limit: limitArg(20, 200),
    },
    annotations: READ_ONLY,
  }, async (a) => text(await searchItems(ctx, a)));

  server.registerTool("decisions", {
    title: "Decisions",
    description:
      "Decisions made in meetings, each with the meeting and the exact quote. Filter by date and/or topic: " +
      "\"what did we decide about the dividend banner?\" -> query: \"dividend banner\".",
    inputSchema: {
      since: z.string().max(40).optional().describe("Only decisions from meetings on or after this date: YYYY-MM-DD (user's local day) or an ISO time."),
      query: z.string().max(200).optional().describe("Topic words to match; results best match first."),
      limit: limitArg(30, 500),
    },
    annotations: READ_ONLY,
  }, async (a) => {
    if (a.since && Number.isNaN(Date.parse(a.since))) return text(`"since" must be a date like 2026-11-01.`, true);
    return text(await decisions(ctx, a));
  });

  server.registerTool("today", {
    title: "Today's brief",
    description: "The same content as the Today screen: what the user owes, is waiting on and decided today, what closed today, and older items still open.",
    inputSchema: {},
    annotations: READ_ONLY,
  }, async () => text(await today(ctx)));

  server.registerTool("mark_item", {
    title: "Mark an item",
    description:
      "Change an item's status, exactly like the Done / Wrong / Undo buttons in the app: done = it happened; " +
      "wrong = not a real item, hide it; open = reopen. Only call when the user asks. Takes the id shown in [brackets].",
    inputSchema: {
      id: z.string().min(6).max(64).describe("The item id from another tool's output (a unique prefix of 6+ characters also works)."),
      status: z.enum(["done", "wrong", "open"]),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (a) => { const r = await markItem(ctx, a); return text(r.text, r.isError); });

  return server;
}
