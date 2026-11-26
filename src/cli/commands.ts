// daily-brief: the command line for your brief. Reads and writes the same state.json as the app
// (FileStore, which reloads when the file changed and writes through change()), so the app sees
// every change on its next read. Nothing here calls Wispr Flow; only `ask` calls the Anthropic API.

import { streamAnswer, type StreamingClient } from "@/lib/ask/ask";
import { fitSources } from "@/lib/ask/prompt";
import { MAX_QUESTION_CHARS, retrieve } from "@/lib/ask/retrieve";
import { buildBrief } from "@/lib/brief/build";
import { dueLabel, formatTime, lateLabel, localDate, localDayBounds } from "@/lib/brief/time";
import { isSnoozed } from "@/lib/capture/items";
import { parseCapture, parseDue } from "@/lib/capture/parse";
import { belongsTo, listPeople, normalizeName, personDetail } from "@/lib/people";
import { priorityContext, priorityOf, rankByPriority, topN, type Priority } from "@/lib/priority";
import { buildIndex, search as searchIndex, type SearchHit } from "@/lib/search";
import type { Item } from "@/lib/types";
import { findItem, noSuchPerson, resolvePerson, snapshot, type Snapshot } from "@/mcp/tools";
import type { MemoryStore } from "@/server/store";
import { line, mark, type Style } from "./style";

export interface CliDeps {
  /** A FileStore on state.json in real use; a MemoryStore works in tests. */
  store: MemoryStore;
  now?: () => Date;
  out: (s: string) => void;
  err: (s: string) => void;
  style: Style;
  /** The app's address, for `open`. */
  appUrl: string;
  /** Opens a URL in the browser or the app. Resolves false when it couldn't. */
  open?: (url: string) => Promise<boolean>;
  /** Where `ask` streams the answer as it arrives (a TTY). Without it the answer prints at the end. */
  stream?: (chunk: string) => void;
  /** The Anthropic client for `ask`, or null when no key is set. */
  ai?: () => Promise<{ client: StreamingClient; model: string } | null>;
}

export const NOT_SET_UP = "Daily brief isn't set up yet: open the app and save your name first.";

// ---------- arguments ----------

export interface Args {
  cmd: string;
  pos: string[];
  json: boolean;
  all: boolean;
  since?: string;
  limit?: number;
  help: boolean;
  color?: boolean;
}

/** Parse argv (without node and the script). Flags may come anywhere; `--` ends them. */
export function parseArgs(argv: string[]): Args {
  const a: Args = { cmd: "", pos: [], json: false, all: false, help: false };
  let rest = false;
  for (let k = 0; k < argv.length; k++) {
    const x = argv[k];
    if (rest || !x.startsWith("-") || x === "-") { a.pos.push(x); continue; }
    if (x === "--") { rest = true; continue; }
    const eq = x.indexOf("=");
    const flag = eq > 0 ? x.slice(0, eq) : x;
    const inline = eq > 0 ? x.slice(eq + 1) : undefined;
    const value = () => inline ?? argv[++k];
    switch (flag) {
      case "--json": a.json = true; break;
      case "--all": case "-a": a.all = true; break;
      case "--since": a.since = value(); break;
      case "--limit": case "-n": a.limit = Number(value()); break;
      case "--help": case "-h": a.help = true; break;
      case "--no-color": a.color = false; break;
      case "--color": a.color = true; break;
      default: a.pos.push(x);
    }
  }
  a.cmd = (a.pos.shift() ?? "today").toLowerCase();
  return a;
}

export const HELP = `daily-brief: your meetings' promises, in the terminal

Reads
  today                     Today: Top 3, what you owe, wait on, decided, closed
  owe [person]              Everything you owe, most pressing first
  waiting [person]          Everything you're waiting on, soonest due first
  decisions [words]         Decisions, newest first   --since 2026-11-01
  search <words>            Items and meetings         --all includes closed
  person <name>             Everything with one person
Writes
  add "<text>"              "send Nitin the deck by Fri", "Tarun owes me the spec tomorrow"
  done <id>                 Mark done                 (ids: the 8 characters shown, or more)
  wrong <id>                Not a real item: hide it
  undo <id>                 Reopen
  snooze <id> <when>        tomorrow, mon, next week, in 3 days, 2026-12-01, off
  star <id> / unstar <id>   Pin to the top of its list
Other
  ask "<question>"          Ask Claude about your meetings (needs your Anthropic key; about ₹1)
  open [id|review|people]   Open the app

Flags: --json on reads, --limit N, --no-color. Data: $DAILY_BRIEF_DIR or ~/Daily Brief.`;

// ---------- formatting ----------

const short = (id: string) => id.slice(0, 8);
const started = (i: Item, s: Snapshot) => s.byId.get(i.meetingId)?.startedAt ?? i.createdAt;
const day = (iso: string, tz: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: tz });
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

function lateMinutes(i: Item, now: Date): number | null {
  return i.status === "open" && i.dueAt && i.kind !== "decision" && Date.parse(i.dueAt) < now.getTime()
    ? Math.floor((now.getTime() - Date.parse(i.dueAt)) / 60000) : null;
}

/** The right-hand label: "2d late", "Tomorrow 6:00 PM", "done", "snoozed till 1 Dec". */
function sideLabel(i: Item, s: Snapshot, st: Style): string {
  if (i.status === "done") return st.dim("done");
  if (i.status === "wrong") return st.dim("wrong");
  const late = lateMinutes(i, s.now);
  if (late !== null) return st.red(lateLabel(late));
  const parts: string[] = [];
  if (i.starred) parts.push(st.lime("★"));
  if (i.snoozedUntil && isSnoozed(i, localDate(s.now, s.user.timeZone))) parts.push(st.dim(`snoozed till ${day(i.snoozedUntil + "T12:00:00Z", "UTC")}`));
  else if (i.dueAt && i.kind !== "decision") parts.push(st.dim(`${dueLabel(i.dueAt, s.now, s.user.timeZone)} ${formatTime(i.dueAt, s.user.timeZone)}`));
  return parts.join(" ");
}

/**
 *   ■ Send Nitin the final banner text                     2d late
 *     Nitin · Standup, 25 Nov · "I'll send it tonight" · 1a2b3c4d
 */
export function itemLines(i: Item, s: Snapshot, st: Style, extra?: string): string {
  const tz = s.user.timeZone;
  const late = lateMinutes(i, s.now) !== null;
  const m = s.byId.get(i.meetingId);
  const src = i.source === "manual" ? "added by you" : m ? `${m.title}, ${day(m.startedAt, tz)}` : "a meeting";
  const meta = [i.person, src, i.source === "manual" ? i.note : i.quote ? `“${i.quote}”` : null, extra].filter(Boolean).join(" · ");
  const head = line(`  ${mark(i, late, st)} `, i.text, sideLabel(i, s, st), st);
  return `${head}\n${line("    ", meta, st.dim(short(i.id)), st, st.dim)}`;
}

function section(title: string, items: Item[], s: Snapshot, st: Style, empty?: string, extra?: (i: Item) => string | undefined): string {
  if (!items.length) return empty ? `${st.head(title)}\n  ${st.dim(empty)}` : "";
  return `${st.head(title, items.length)}\n${items.map((i) => itemLines(i, s, st, extra?.(i))).join("\n")}`;
}

const join = (...parts: string[]) => parts.filter(Boolean).join("\n\n");

/** One item as JSON for scripts. */
export function itemJson(i: Item, s: Snapshot, priority?: Priority) {
  const m = s.byId.get(i.meetingId);
  const late = lateMinutes(i, s.now);
  return {
    id: i.id, kind: i.kind, status: i.status, text: i.text, person: i.person,
    dueAt: i.dueAt, late: late !== null, lateLabel: late !== null ? lateLabel(late) : null,
    starred: !!i.starred, snoozedUntil: i.snoozedUntil ?? null, source: i.source ?? "extracted",
    note: i.note ?? null, quote: i.quote || null,
    meeting: m ? { id: m.id, title: m.title, startedAt: m.startedAt } : null,
    closedAt: i.closedAt, closeQuote: i.closeQuote,
    ...(priority ? { priority } : {}),
  };
}

// ---------- commands ----------

type Result = { code: number };
const ok: Result = { code: 0 };
const fail: Result = { code: 1 };

export async function run(argv: string[], deps: CliDeps): Promise<number> {
  const a = parseArgs(argv);
  if (a.help || a.cmd === "help") { deps.out(HELP); return 0; }
  const cmd = COMMANDS[a.cmd];
  if (!cmd) { deps.err(`Unknown command "${a.cmd}". Try: daily-brief help`); return 2; }
  if (a.limit !== undefined && (!Number.isInteger(a.limit) || a.limit < 1)) { deps.err("--limit takes a whole number."); return 2; }
  try {
    return (await cmd(a, deps)).code;
  } catch (e) {
    deps.err(`daily-brief: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

async function snap(d: CliDeps): Promise<Snapshot | null> {
  const s = await snapshot({ store: d.store, now: d.now });
  if (!s) d.err(NOT_SET_UP);
  return s;
}

const print = (d: CliDeps, a: Args, json: () => unknown, text: () => string): Result => {
  d.out(a.json ? JSON.stringify(json(), null, 2) : text());
  return ok;
};

/** Open items of one kind, optionally for one person. Null (after an error) when the person is unknown. */
function openOf(kind: Item["kind"], s: Snapshot, a: Args, d: CliDeps): { items: Item[]; who: string } | null {
  let items = s.items.filter((i) => i.kind === kind && i.status === "open");
  const today = localDate(s.now, s.user.timeZone);
  if (!a.all) items = items.filter((i) => !isSnoozed(i, today));
  const name = a.pos.join(" ").trim();
  if (!name) return { items, who: "" };
  const r = resolvePerson(name, s);
  if (!("person" in r)) { d.err(noSuchPerson(name, r.candidates, s)); return null; }
  return { items: items.filter((i) => belongsTo(r.person, i.person)), who: r.person.name };
}

const COMMANDS: Record<string, (a: Args, d: CliDeps) => Promise<Result>> = {
  async today(a, d) {
    const s = await snap(d);
    if (!s) return fail;
    const b = await buildBrief(d.store, s.user, s.now);
    const byId = new Map(s.items.map((i) => [i.id, i]));
    const pick = (ids: string[]) => ids.map((id) => byId.get(id)).filter((i): i is Item => !!i);
    const ctx = priorityContext(s.items, s.meetings, s.now);
    const owe = rankByPriority(pick(b.youOwe.map((l) => l.itemId)), (i) => i.id, ctx);
    const top = topN(owe);
    const waiting = pick(b.waitingOn.map((l) => l.itemId));
    const decided = pick(b.decisions.map((l) => l.itemId));
    const closed = pick(b.closedToday.map((c) => c.itemId));
    const still = pick(b.stillOpen.map((l) => l.itemId));
    const st = d.style;
    return print(d, a,
      () => ({
        date: b.date, dateLabel: b.dateLabel, meetings: b.meetingCount, subject: b.subject,
        top: top.map((i) => itemJson(i, s, i.priority)),
        youOwe: owe.map((i) => itemJson(i, s, i.priority)),
        waitingOn: waiting.map((i) => itemJson(i, s)),
        decisions: decided.map((i) => itemJson(i, s)),
        closedToday: closed.map((i) => itemJson(i, s)),
        stillOpen: { count: b.stillOpenCount, shown: still.map((i) => itemJson(i, s)) },
      }),
      () => join(
        `${st.bold(b.dateLabel)}\n${st.dim(`${b.meetingCount ? `From ${plural(b.meetingCount, "meeting")} today` : "No meetings yet today"} · ${b.subject.replace(/^Your day: /, "")}`)}`,
        top.length ? `${st.head(`Top ${top.length} today`)}\n${top.map((i, k) => line(`  ${st.lime(String(k + 1))} `, i.text, st.dim(i.priority.reasons.slice(0, 2).join(", ")), st)).join("\n")}` : "",
        section("You owe", owe, s, st, b.meetingCount ? "Nothing owed. Go home." : "Nothing owed today."),
        section("Waiting on", waiting, s, st, "Nobody owes you anything today."),
        section("Decisions", decided, s, st),
        section("Closed today", closed, s, st),
        b.stillOpenCount ? `${section("Still open from before", still, s, st)}${b.stillOpenCount > still.length ? `\n  ${st.dim(`…and ${b.stillOpenCount - still.length} more: daily-brief owe / waiting`)}` : ""}` : "",
      ));
  },

  async owe(a, d) {
    const s = await snap(d);
    if (!s) return fail;
    const r = openOf("owe", s, a, d);
    if (!r) return fail;
    const ranked = rankByPriority(r.items.sort(byDue(s)), (i) => i.id, priorityContext(s.items, s.meetings, s.now)).slice(0, a.limit ?? 200);
    return print(d, a,
      () => ranked.map((i) => itemJson(i, s, i.priority)),
      () => section(`You owe${r.who ? ` ${r.who}` : ""}`, ranked, s, d.style, `Nothing owed${r.who ? ` to ${r.who}` : ""}.`, (i) => {
        const why = (ranked.find((x) => x.id === i.id)?.priority.reasons ?? []).filter((x) => !/late$|^due in/.test(x)).slice(0, 2);
        return why.length ? why.join(", ") : undefined;
      }));
  },

  async waiting(a, d) {
    const s = await snap(d);
    if (!s) return fail;
    const r = openOf("waiting", s, a, d);
    if (!r) return fail;
    const items = r.items.sort(byDue(s)).slice(0, a.limit ?? 200);
    return print(d, a, () => items.map((i) => itemJson(i, s)),
      () => section(`Waiting on${r.who ? ` ${r.who}` : ""}`, items, s, d.style, r.who ? `${r.who} owes you nothing.` : "Nobody owes you anything."));
  },

  async decisions(a, d) {
    const s = await snap(d);
    if (!s) return fail;
    let ds = s.items.filter((i) => i.kind === "decision" && i.status !== "wrong");
    if (a.since) {
      const from = /^\d{4}-\d{2}-\d{2}$/.test(a.since) ? localDayBounds(a.since, s.user.timeZone).startIso
        : Number.isNaN(Date.parse(a.since)) ? null : new Date(a.since).toISOString();
      if (!from) { d.err(`--since takes a date like 2026-11-01.`); return { code: 2 }; }
      ds = ds.filter((i) => started(i, s) >= from);
    }
    const q = a.pos.join(" ").trim();
    if (q) {
      const order = new Map(searchIndex(buildIndex(ds, s.meetings), q.slice(0, 200), 500).filter((h) => h.type === "item").map((h, n) => [h.id, n]));
      ds = ds.filter((i) => order.has(i.id)).sort((x, y) => order.get(x.id)! - order.get(y.id)!);
    } else {
      ds.sort((x, y) => started(y, s).localeCompare(started(x, s)));
    }
    ds = ds.slice(0, a.limit ?? 50);
    const what = [q ? `about "${q}"` : "", a.since ? `since ${a.since}` : ""].filter(Boolean).join(" ");
    return print(d, a, () => ds.map((i) => itemJson(i, s)),
      () => section(`Decisions${what ? ` ${what}` : ""}`, ds, s, d.style, `No decisions${what ? ` ${what}` : ""}.`));
  },

  async search(a, d) {
    const q = a.pos.join(" ").trim();
    if (!q) { d.err('Search for what? daily-brief search "banner"'); return { code: 2 }; }
    const s = await snap(d);
    if (!s) return fail;
    const hits = searchIndex(buildIndex(s.items, s.meetings), q.slice(0, 200), 500);
    const byId = new Map(s.items.map((i) => [i.id, i]));
    const items = hits.filter((h): h is Extract<SearchHit, { type: "item" }> => h.type === "item")
      .filter((h) => a.all || h.status === "open").slice(0, a.limit ?? 20).map((h) => byId.get(h.id)!).filter(Boolean);
    const met = hits.filter((h): h is Extract<SearchHit, { type: "meeting" }> => h.type === "meeting").slice(0, 5);
    const st = d.style;
    return print(d, a,
      () => ({ items: items.map((i) => itemJson(i, s)), meetings: met.map((m) => ({ id: m.id, title: m.title, at: m.at, participants: m.participants })) }),
      () => {
        if (!items.length && !met.length) return `Nothing matches "${q}"${a.all ? "" : " in open items (try --all)"}.`;
        return join(
          section(a.all ? "Items" : "Open items", items, s, st, a.all ? "No items match." : "No open items match (try --all)."),
          met.length ? `${st.head("Meetings", met.length)}\n${met.map((m) => line("  ", m.title, st.dim(day(m.at, s.user.timeZone)), st)).join("\n")}` : "",
        );
      });
  },

  async person(a, d) {
    const name = a.pos.join(" ").trim();
    if (!name) { d.err("Which person? daily-brief person Nitin"); return { code: 2 }; }
    const s = await snap(d);
    if (!s) return fail;
    const r = resolvePerson(name, s);
    if (!("person" in r)) { d.err(noSuchPerson(name, r.candidates, s)); return fail; }
    const self = [s.user.name, ...s.user.aliases];
    const det = personDetail(r.person.slug, { items: s.items, meetings: s.meetings, now: s.now, self, people: s.people }, 30)!;
    const p = det.person;
    const st = d.style;
    const last = det.meetings[0];
    return print(d, a,
      () => ({
        name: p.name, spellings: p.spellings, meetings: det.meetings.length, overdue: det.summary.overdue,
        youOwe: det.youOwe.map((i) => itemJson(i, s, priorityOf(i, priorityContext(s.items, s.meetings, s.now)))),
        waitingOn: det.waitingOn.map((i) => itemJson(i, s)),
        closedRecently: det.closed.map((i) => itemJson(i, s)),
        decisions: det.decisions.slice(0, 15).map((i) => itemJson(i, s)),
      }),
      () => join(
        `${st.bold(p.name)}\n${st.dim(`You owe ${det.youOwe.length} · they owe you ${det.waitingOn.length} · ${det.summary.overdue} overdue · ${plural(det.meetings.length, "meeting")} together${last ? `, last ${last.title} on ${day(last.startedAt, s.user.timeZone)}` : ""}`)}`,
        section("You owe", det.youOwe, s, st, `Nothing owed to ${p.name}.`),
        section("Waiting on", det.waitingOn, s, st, `${p.name} owes you nothing.`),
        section("Closed in the last 30 days", det.closed, s, st),
        section("Decisions together", det.decisions.slice(0, 10), s, st),
      ));
  },

  async add(a, d) {
    const text = a.pos.join(" ").trim();
    if (!text) { d.err('Add what? daily-brief add "send Nitin the deck by Fri"'); return { code: 2 }; }
    if (text.length > 300) { d.err("Keep it under 300 characters."); return { code: 2 }; }
    const s = await snap(d);
    if (!s) return fail;
    const self = [s.user.name, ...s.user.aliases].filter(Boolean);
    const skip = new Set(self.map(normalizeName));
    const people = listPeople({ items: s.items, meetings: s.meetings, now: s.now, self, people: s.people }).map((p) => p.name);
    for (const m of s.meetings) for (const p of m.participants) if (!p.includes("@") && !skip.has(normalizeName(p))) people.push(p);
    const parsed = parseCapture(text, { people: [...new Set(people)], self, now: s.now, timeZone: s.user.timeZone });
    const item = await d.store.addManualItem(s.user.id, { kind: parsed.kind, text: parsed.text, person: parsed.person, dueAt: parsed.dueAt }, s.now.toISOString());
    const after = (await snapshot({ store: d.store, now: d.now }))!;
    return print(d, a, () => itemJson(item, after), () => `${d.style.bold("Added")}\n${itemLines(item, after, d.style)}`);
  },

  done: (a, d) => setStatus(a, d, "done"),
  wrong: (a, d) => setStatus(a, d, "wrong"),
  undo: (a, d) => setStatus(a, d, "open"),
  reopen: (a, d) => setStatus(a, d, "open"),
  star: (a, d) => setStar(a, d, true),
  unstar: (a, d) => setStar(a, d, false),

  async snooze(a, d) {
    const [id, ...when] = a.pos;
    if (!id || !when.length) { d.err("daily-brief snooze <id> <when>: tomorrow, mon, next week, in 3 days, 2026-12-01, or off"); return { code: 2 }; }
    const s = await snap(d);
    if (!s) return fail;
    const f = findItem(id, s);
    if ("error" in f) { d.err(cliIdError(f.error)); return fail; }
    const w = when.join(" ").trim();
    const today = localDate(s.now, s.user.timeZone);
    let until: string | null;
    if (/^(off|none|clear|now|wake)$/i.test(w)) until = null;
    else {
      const parsed = parseDue(w, today).date;
      if (!parsed) { d.err(`Couldn't read "${w}" as a day. Try tomorrow, mon, next week, in 3 days or 2026-12-01.`); return { code: 2 }; }
      if (parsed <= today) { d.err("Pick a day after today."); return { code: 2 }; }
      until = parsed;
    }
    const item = (await d.store.updateItem(f.item.id, { snoozedUntil: until }))!;
    const after = (await snapshot({ store: d.store, now: d.now }))!;
    return print(d, a, () => itemJson(item, after),
      () => `${d.style.bold(until ? `Snoozed till ${new Date(until + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })}` : "Back now")}\n${itemLines(item, after, d.style)}`);
  },

  async ask(a, d) {
    const q = a.pos.join(" ").trim().slice(0, MAX_QUESTION_CHARS);
    if (!q) { d.err('Ask what? daily-brief ask "what did I promise Tarun this week?"'); return { code: 2 }; }
    const s = await snap(d);
    if (!s) return fail;
    const sources = fitSources(retrieve(q, s.items, s.meetings, s.now), s.user.timeZone).map((x, k) => ({ ...x, n: k + 1 }));
    const ai = sources.length ? await d.ai?.() : null;
    if (sources.length && !ai) {
      d.err("Ask needs your Anthropic API key: set ANTHROPIC_API_KEY, or save the key in the app's Settings (it goes in the Keychain).");
      return fail;
    }
    let answer = "";
    let code = 0;
    let cost: number | null = null;
    const input = { question: q, sources, userName: s.user.name, timeZone: s.user.timeZone, now: s.now };
    for await (const ev of streamAnswer(input, { client: ai?.client as StreamingClient, model: ai?.model ?? "" })) {
      if (ev.type === "text") { answer += ev.text; if (!a.json) d.stream?.(ev.text); }
      else if (ev.type === "error") { d.err(ev.error); code = 1; }
      else {
        cost = ev.costInr;
        if (ev.usage) {
          await d.store.logEvent({ userId: s.user.id, type: "ask", payload: { model: ai?.model, sources: sources.length, noAnswer: ev.noAnswer, via: "cli" },
            tokensIn: ev.usage.inputTokens, tokensOut: ev.usage.outputTokens, costInr: ev.costInr ?? undefined });
        }
      }
    }
    const streamed = !a.json && !!d.stream;
    const st = d.style;
    if (a.json) {
      d.out(JSON.stringify({ question: q, answer, costInr: cost, sources: sources.map((x) => ({ n: x.n, id: x.itemId, kind: x.kind, text: x.text, person: x.person, meeting: x.meetingTitle, at: x.at })) }, null, 2));
    } else {
      const cited = new Set([...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
      const shown = sources.filter((x) => cited.has(x.n));
      d.out(join(
        streamed ? "\n" : answer.trim(),
        shown.length ? shown.map((x) => st.dim(`[${x.n}] ${x.text}${x.person ? ` · ${x.person}` : ""} · ${x.meetingTitle}, ${day(x.at, s.user.timeZone)} · ${short(x.itemId)}`)).join("\n") : "",
        cost ? st.dim(`about ₹${cost.toFixed(2)}`) : "",
      ));
    }
    return { code };
  },

  async open(a, d) {
    const what = a.pos[0];
    let path = "/";
    if (what) {
      if (/^(review|people|ask|open|week|wrap|search|setup|series)$/i.test(what)) path = `/${what.toLowerCase()}`;
      else {
        const s = await snap(d);
        if (!s) return fail;
        const f = findItem(what, s);
        if ("error" in f) { d.err(cliIdError(f.error)); return fail; }
        path = `/item/${encodeURIComponent(f.item.id)}`;
      }
    }
    const url = d.appUrl.replace(/\/$/, "") + path;
    const opened = d.open ? await d.open(url) : false;
    d.out(opened ? `Opened ${url}` : url);
    return ok;
  },
};

/** findItem's message, with the CLI's way of showing ids. */
const cliIdError = (e: string) => e.replace("Ids are shown in [brackets] by the other tools.", "Ids are the 8 characters at the end of each item's second line.");

/** Due soonest first (overdue first), undated last, then oldest. */
const byDue = (s: Snapshot) => (x: Item, y: Item) =>
  (x.dueAt ? Date.parse(x.dueAt) : Infinity) - (y.dueAt ? Date.parse(y.dueAt) : Infinity) || started(x, s).localeCompare(started(y, s));

async function setStatus(a: Args, d: CliDeps, status: Item["status"]): Promise<Result> {
  const id = a.pos[0];
  if (!id) { d.err(`daily-brief ${status === "open" ? "undo" : status} <id>`); return { code: 2 }; }
  const s = await snap(d);
  if (!s) return fail;
  const f = findItem(id, s);
  if ("error" in f) { d.err(cliIdError(f.error)); return fail; }
  const before = f.item.status;
  const verb = status === "done" ? "Marked done" : status === "wrong" ? "Marked wrong (hidden from the brief)" : "Reopened";
  if (before !== status) await d.store.setItemStatus(f.item.id, status, s.now.toISOString());
  const after = (await snapshot({ store: d.store, now: d.now }))!;
  const item = after.items.find((i) => i.id === f.item.id)!;
  if (item.status !== status) { d.err("The change didn't stick; try again."); return fail; }
  return print(d, a, () => itemJson(item, after),
    () => `${d.style.bold(before === status ? `Already ${status}` : verb)}\n${itemLines(item, after, d.style)}`);
}

async function setStar(a: Args, d: CliDeps, starred: boolean): Promise<Result> {
  const id = a.pos[0];
  if (!id) { d.err(`daily-brief ${starred ? "star" : "unstar"} <id>`); return { code: 2 }; }
  const s = await snap(d);
  if (!s) return fail;
  const f = findItem(id, s);
  if ("error" in f) { d.err(cliIdError(f.error)); return fail; }
  if (f.item.kind === "decision") { d.err("Decisions can't be starred."); return fail; }
  const item = (await d.store.updateItem(f.item.id, { starred }))!;
  const after = (await snapshot({ store: d.store, now: d.now }))!;
  return print(d, a, () => itemJson(item, after), () => `${d.style.bold(starred ? "Starred" : "Unstarred")}\n${itemLines(item, after, d.style)}`);
}
