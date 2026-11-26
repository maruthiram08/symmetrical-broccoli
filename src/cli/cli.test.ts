import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { fakeStream } from "@/lib/ai/fakes.test-helpers";
import type { Item } from "@/lib/types";
import { FileStore } from "@/server/local/file-store";
import { parseArgs, run, type CliDeps } from "./commands";
import { line, makeStyle, wantColor } from "./style";

// Thursday 26 Nov 2026, 11:30 AM in Kolkata.
const NOW = new Date("2026-11-26T06:00:00Z");
const ROOT = resolve(__dirname, "../..");

interface Seeded { dir: string; path: string; ids: Record<string, string> }

/** A temp ~/Daily Brief with one user, three meetings and a spread of items. */
async function seed(): Promise<Seeded> {
  const dir = mkdtempSync(join(tmpdir(), "db-cli-"));
  const path = join(dir, ".daily-brief", "state.json");
  const store = new FileStore(path);
  const u = store.addUser({ email: "you@this-mac", name: "Maruthi", aliases: ["Maru"], timeZone: "Asia/Kolkata" });
  const meet = async (p: string, title: string, startedAt: string, participants: string[]) =>
    (await store.upsertMeeting({ userId: u.id, providerMeetingId: p, title, startedAt, participants })).meeting;
  const old = await meet("m1", "Dividend sync", "2026-11-20T06:00:00Z", ["Tarun Mehta", "Nitin K"]);
  const tod = await meet("m2", "Standup", "2026-11-26T04:00:00Z", ["Nitin K", "Priya"]);
  const it = (kind: Item["kind"], text: string, person: string | null, quote: string, meetingId: string, dueAt: string | null = null) =>
    ({ kind, text, person, quote, meetingId, dueAt });
  await store.commitExtraction({ meetingId: old.id, userId: u.id, at: "2026-11-20T07:00:00Z", closes: [], newItems: [
    it("owe", "Send Tarun the dividend banner copy", "Tarun Mehta", "I'll send you the banner copy", old.id, "2026-11-21T12:30:00Z"),
    it("owe", "Review Tarun's onboarding deck", "Tarun", "can you review my deck", old.id),
    it("decision", "Show the dividend banner only to holders", null, "let's only show the banner to holders", old.id),
    it("waiting", "Nitin to share the payout calendar", "Nitin K", "I'll share the payout calendar", old.id, "2026-11-28T12:30:00Z"),
  ] });
  await store.commitExtraction({ meetingId: tod.id, userId: u.id, at: "2026-11-26T05:00:00Z", closes: [], newItems: [
    it("owe", "Book the offsite venue", "Priya", "I'll book the venue today", tod.id, "2026-11-26T12:30:00Z"),
    it("owe", "Send Priya the agenda", "Priya", "agenda to you", tod.id),
    it("decision", "Move standup to 9:30", null, "standup at 9:30 from Monday", tod.id),
  ] });
  const all = await store.listItems(u.id);
  const ids = Object.fromEntries(all.map((i) => [i.text.split(" ").slice(0, 2).join(" "), i.id]));
  return { dir, path, ids };
}

interface Ran { code: number; out: string; err: string; store: FileStore }

async function cli(s: Seeded, argv: string[], over: Partial<CliDeps> = {}): Promise<Ran> {
  const out: string[] = [];
  const err: string[] = [];
  // A fresh store each call, like a new process next to the running app.
  const store = new FileStore(s.path);
  const code = await run(argv, {
    store, now: () => NOW, style: makeStyle({ color: false }), appUrl: "http://localhost:4242",
    out: (x) => out.push(x), err: (x) => err.push(x), ...over,
  });
  return { code, out: out.join("\n"), err: err.join("\n"), store };
}

let s: Seeded;
beforeEach(async () => { s = await seed(); });

describe("parseArgs", () => {
  it("takes flags anywhere, --since in both forms, and today by default", () => {
    expect(parseArgs([])).toMatchObject({ cmd: "today", pos: [], json: false });
    expect(parseArgs(["owe", "--json", "Tarun"])).toMatchObject({ cmd: "owe", pos: ["Tarun"], json: true });
    expect(parseArgs(["decisions", "--since=2026-11-01"]).since).toBe("2026-11-01");
    expect(parseArgs(["decisions", "--since", "2026-11-01", "banner"])).toMatchObject({ since: "2026-11-01", pos: ["banner"] });
    expect(parseArgs(["add", "--", "--weird text"]).pos).toEqual(["--weird text"]);
    expect(parseArgs(["owe", "--no-color", "-n", "3"])).toMatchObject({ color: false, limit: 3 });
  });
});

describe("reads", () => {
  it("today: Top 3 by priority, then sections, with short ids and no colour off a TTY", async () => {
    const r = await cli(s, ["today"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Thursday, 26 November");
    expect(r.out).toContain("TOP 3 TODAY");
    const top = r.out.split("TOP 3 TODAY")[1].split("\n\n")[0];
    // Overdue banner copy first, then the venue due today.
    expect(top.indexOf("Send Tarun the dividend banner copy")).toBeLessThan(top.indexOf("Book the offsite venue"));
    expect(r.out).toContain("YOU OWE");
    expect(r.out).toContain(s.ids["Send Tarun"].slice(0, 8));
    expect(r.out).toContain("4d late");
    expect(r.out).not.toContain("\x1b[");
  });

  it("today --json has the same lists", async () => {
    const r = await cli(s, ["today", "--json"]);
    const j = JSON.parse(r.out);
    expect(j.date).toBe("2026-11-26");
    expect(j.top[0]).toMatchObject({ text: "Send Tarun the dividend banner copy", late: true });
    expect(j.top[0].priority.reasons[0]).toBe("4d late");
    expect(j.youOwe.map((i: { text: string }) => i.text)).toContain("Book the offsite venue");
    expect(j.decisions.map((i: { text: string }) => i.text)).toEqual(["Move standup to 9:30"]);
  });

  it("owe ranks by priority and filters by person (fuzzy)", async () => {
    const all = JSON.parse((await cli(s, ["owe", "--json"])).out);
    expect(all.map((i: { text: string }) => i.text)[0]).toBe("Send Tarun the dividend banner copy");
    expect(all).toHaveLength(4);
    const tarun = JSON.parse((await cli(s, ["owe", "tarun", "--json"])).out);
    expect(tarun.map((i: { text: string }) => i.text).sort()).toEqual(["Review Tarun's onboarding deck", "Send Tarun the dividend banner copy"]);
    const text = (await cli(s, ["owe", "tarun"])).out;
    expect(text).toContain("YOU OWE TARUN MEHTA 2");
    const none = await cli(s, ["owe", "zed"]);
    expect(none.code).toBe(1);
    expect(none.err).toContain('Nobody called "zed"');
  });

  it("waiting, decisions --since, search, person", async () => {
    expect((await cli(s, ["waiting", "nitin"])).out).toContain("Nitin to share the payout calendar");
    const since = JSON.parse((await cli(s, ["decisions", "--since", "2026-11-25", "--json"])).out);
    expect(since.map((i: { text: string }) => i.text)).toEqual(["Move standup to 9:30"]);
    expect((await cli(s, ["decisions", "--since", "soon"])).code).toBe(2);
    const about = (await cli(s, ["decisions", "banner"])).out;
    expect(about).toContain('DECISIONS ABOUT "BANNER" 1');
    const found = JSON.parse((await cli(s, ["search", "venue", "--json"])).out);
    expect(found.items[0].text).toBe("Book the offsite venue");
    expect((await cli(s, ["search", "zzzz"])).out).toContain('Nothing matches "zzzz"');
    const p = (await cli(s, ["person", "Priya"])).out;
    expect(p).toContain("You owe 2 · they owe you 0");
    expect(p).toContain("Send Priya the agenda");
  });

  it("explains when the app isn't set up", async () => {
    const empty = { dir: "", path: join(mkdtempSync(join(tmpdir(), "db-cli-")), "state.json"), ids: {} };
    const r = await cli(empty, ["today"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("isn't set up");
  });

  it("help and unknown commands", async () => {
    expect((await cli(s, ["help"])).out).toContain("snooze <id> <when>");
    const r = await cli(s, ["frobnicate"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("Unknown command");
  });
});

describe("writes go to state.json", () => {
  const onDisk = (id: string) => (JSON.parse(readFileSync(s.path, "utf8")).items as Item[]).find((i) => i.id === id)!;

  it("add parses natural text with the quick-capture parser and known people", async () => {
    const r = await cli(s, ["add", "send", "priya", "the", "budget", "by", "fri"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Added");
    const items = JSON.parse(readFileSync(s.path, "utf8")).items as Item[];
    const added = items.find((i) => i.source === "manual")!;
    expect(added).toMatchObject({ kind: "owe", text: "Send Priya the budget", person: "Priya", dueAt: "2026-11-27T12:30:00.000Z" });
    const w = JSON.parse((await cli(s, ["add", "Tarun owes me the API spec tomorrow", "--json"])).out);
    expect(w).toMatchObject({ kind: "waiting", text: "Tarun Mehta to send the API spec", person: "Tarun Mehta", source: "manual" });
    expect((await cli(s, ["add"])).code).toBe(2);
  });

  it("done, wrong and undo by short id; ambiguous or unknown ids fail", async () => {
    const id = s.ids["Book the"];
    const r = await cli(s, ["done", id.slice(0, 8)]);
    expect(r.out).toContain("Marked done");
    expect(onDisk(id).status).toBe("done");
    expect((await cli(s, ["done", id])).out).toContain("Already done");
    expect((await cli(s, ["undo", id])).out).toContain("Reopened");
    expect(onDisk(id).status).toBe("open");
    await cli(s, ["wrong", id]);
    expect(onDisk(id).status).toBe("wrong");
    const bad = await cli(s, ["done", "nope-nope"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("8 characters");
  });

  it("star / unstar, and stars move an item up", async () => {
    const id = s.ids["Send Priya"];
    await cli(s, ["star", id.slice(0, 8)]);
    expect(onDisk(id).starred).toBe(true);
    const owe = JSON.parse((await cli(s, ["owe", "--json"])).out);
    expect(owe[0].text).not.toBe("Send Priya the agenda"); // overdue still outranks a star
    expect(owe.findIndex((i: { id: string }) => i.id === id)).toBeLessThan(3);
    await cli(s, ["unstar", id]);
    expect(onDisk(id).starred).toBe(false);
    expect((await cli(s, ["star", s.ids["Move standup"]])).err).toContain("can't be starred");
  });

  it("snooze reads natural days, refuses the past, hides the item, and off brings it back", async () => {
    const id = s.ids["Send Priya"];
    const r = await cli(s, ["snooze", id, "next", "week"]);
    expect(r.out).toContain("Snoozed till Mon 30 Nov");
    expect(onDisk(id).snoozedUntil).toBe("2026-11-30");
    expect(JSON.parse((await cli(s, ["owe", "--json"])).out).map((i: { id: string }) => i.id)).not.toContain(id);
    expect(JSON.parse((await cli(s, ["owe", "--all", "--json"])).out).map((i: { id: string }) => i.id)).toContain(id);
    await cli(s, ["snooze", id, "2026-12-03"]);
    expect(onDisk(id).snoozedUntil).toBe("2026-12-03");
    expect((await cli(s, ["snooze", id, "2026-11-20"])).err).toContain("after today");
    expect((await cli(s, ["snooze", id, "someday"])).code).toBe(2);
    await cli(s, ["snooze", id, "off"]);
    expect(onDisk(id).snoozedUntil).toBeNull();
  });
});

describe("ask", () => {
  it("needs a key when there is something to ask about", async () => {
    const r = await cli(s, ["ask", "what do I owe Tarun?"], { ai: async () => null });
    expect(r.code).toBe(1);
    expect(r.err).toContain("ANTHROPIC_API_KEY");
  });

  it("streams the answer from local sources, lists cited items and logs the cost", async () => {
    const client = fakeStream(["You owe Tarun the banner copy [1]", "."], { usage: { input_tokens: 1000, output_tokens: 50 } as never });
    const chunks: string[] = [];
    const r = await cli(s, ["ask", "what do I owe Tarun?"], { ai: async () => ({ client, model: "claude-sonnet-5-5" }), stream: (t) => chunks.push(t) });
    expect(r.code).toBe(0);
    expect(chunks.join("")).toBe("You owe Tarun the banner copy [1].");
    expect(r.out).toMatch(/\[1\] .*Tarun/);
    const sent = JSON.stringify(client.calls[0].messages);
    expect(sent).toContain("what do I owe Tarun?");
    expect(sent).toContain("banner copy");
    const events = await r.store.listEvents("ask");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ tokensIn: 1000, tokensOut: 50 });
  });

  it("--json gives the answer and sources", async () => {
    const client = fakeStream(["Ship it [1]"]);
    const r = await cli(s, ["ask", "--json", "what did we decide about the banner?"], { ai: async () => ({ client, model: "claude-sonnet-5-5" }) });
    const j = JSON.parse(r.out);
    expect(j.answer).toBe("Ship it [1]");
    expect(j.sources.length).toBeGreaterThan(0);
  });
});

describe("open", () => {
  it("opens Today, a page or an item, and prints the URL when it can't", async () => {
    const opened: string[] = [];
    const open = async (u: string) => { opened.push(u); return true; };
    expect((await cli(s, ["open"], { open })).out).toBe("Opened http://localhost:4242/");
    await cli(s, ["open", "review"], { open });
    await cli(s, ["open", s.ids["Book the"].slice(0, 8)], { open });
    expect(opened.slice(1)).toEqual(["http://localhost:4242/review", `http://localhost:4242/item/${s.ids["Book the"]}`]);
    expect((await cli(s, ["open"], { open: async () => false })).out).toBe("http://localhost:4242/");
  });
});

describe("style", () => {
  it("uses colour only on a TTY without NO_COLOR, and never with --no-color", () => {
    expect(wantColor({ isTTY: true }, {}, undefined)).toBe(true);
    expect(wantColor({ isTTY: false }, {}, undefined)).toBe(false);
    expect(wantColor({ isTTY: true }, { NO_COLOR: "1" }, undefined)).toBe(false);
    expect(wantColor({ isTTY: true }, {}, false)).toBe(false);
    expect(wantColor({ isTTY: false }, { FORCE_COLOR: "1" }, undefined)).toBe(true);
    expect(makeStyle({ color: true }).red("x")).toBe("\x1b[31mx\x1b[39m");
    expect(makeStyle({ color: false }).red("x")).toBe("x");
  });

  it("right-aligns labels to the width and cuts long text", () => {
    const st = makeStyle({ color: true, width: 30 });
    const l = line("  ", "Short", st.red("2d late"), st);
    expect(l.replace(/\x1b\[[0-9;]*m/g, "")).toHaveLength(30);
    const long = line("  ", "A very long item text that will not fit", "late", st);
    expect(long).toContain("…");
    expect(long.length).toBe(30);
    expect(line("  ", "x", "y", makeStyle({ color: false }))).toBe("  x  y");
  });
});

/** This environment without colour switches (vitest sets FORCE_COLOR). */
function plainEnv(): NodeJS.ProcessEnv {
  const { NO_COLOR: _n, FORCE_COLOR: _f, ...rest } = process.env;
  void _n; void _f;
  return rest;
}

describe("the installed command", () => {
  it("install-cli links bin/daily-brief into a writable bin folder, and the link runs", () => {
    const home = mkdtempSync(join(tmpdir(), "db-cli-home-"));
    const bin = join(home, "bin");
    mkdirSync(bin);
    const out = execFileSync("sh", [join(ROOT, "scripts/install-cli.sh")], { env: { ...process.env, HOME: home, DAILY_BRIEF_BIN_DIR: bin, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8" });
    expect(out).toContain(`ln -sf "${join(ROOT, "bin/daily-brief")}" "${join(bin, "daily-brief")}"`);
    expect(out).not.toContain("sudo");
    expect(lstatSync(join(bin, "daily-brief")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(bin, "daily-brief"))).toBe(join(ROOT, "bin/daily-brief"));
    // Through the symlink, from another directory, against the seeded data, not a TTY: plain JSON.
    const json = execFileSync(join(bin, "daily-brief"), ["owe", "--json"], {
      cwd: home, env: { ...plainEnv(), DAILY_BRIEF_DIR: s.dir }, encoding: "utf8",
    });
    expect(JSON.parse(json).length).toBe(4);
    expect(existsSync(s.path)).toBe(true);
  }, 30_000);
});
