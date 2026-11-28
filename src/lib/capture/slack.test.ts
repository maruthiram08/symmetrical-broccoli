import { describe, expect, it } from "vitest";
import { clipToItem, htmlToText, parseClip } from "./slack";

// Friday 27 Nov 2026, 12:30 in Kolkata.
const now = new Date("2026-11-27T07:00:00Z");
const ctx = { self: ["Maruthi Ram", "Maruthi"], now, timeZone: "Asia/Kolkata", today: "2026-11-27" };
const LINK = "https://acme.slack.com/archives/C04ABCDEF/p1764226920123456";

describe("parseClip", () => {
  it("reads one header line per message", () => {
    const c = parseClip("Nitin Kacharia  10:42 AM\ncan you send the final banner text by Monday?\n:+1: 2\n1 reply");
    expect(c.slack).toBe(true);
    expect(c.messages).toEqual([{ from: "Nitin Kacharia", time: "10:42 AM", body: "can you send the final banner text by Monday?" }]);
  });

  it("reads the name and time on two lines, and bracketed times", () => {
    const c = parseClip("Priya\n  9:05 AM\nShipping today\n\nMaruthi Ram [9:07 AM]\n@Priya great, send me the notes");
    expect(c.messages.map((m) => [m.from, m.time, m.body])).toEqual([
      ["Priya", "9:05 AM", "Shipping today"],
      ["Maruthi Ram", "9:07 AM", "@Priya great, send me the notes"],
    ]);
  });

  it("keeps follow-up messages by the same sender", () => {
    const c = parseClip("Jit  11:00 AM\nfirst thing\n11:01\nsecond thing");
    expect(c.messages.map((m) => [m.from, m.body])).toEqual([["Jit", "first thing"], ["Jit", "second thing"]]);
  });

  it("does not take a sentence ending in a time for a header", () => {
    const c = parseClip("Let's meet at 10:30\nbring the deck");
    expect(c.slack).toBe(false);
    expect(c.messages).toEqual([{ from: null, time: null, body: "Let's meet at 10:30\nbring the deck" }]);
  });

  it("reads a permalink: the workspace and when it was sent", () => {
    const c = parseClip(LINK);
    expect(c).toMatchObject({ slack: true, url: LINK, workspace: "acme", messages: [] });
    expect(c.sentAt).toBe(new Date(1764226920 * 1000).toISOString());
  });

  it("finds the permalink in the HTML copy", () => {
    const html = `<div><a href="https://acme.slack.com/team/U1">Nitin</a> <a href="${LINK}?thread_ts=1764226920.123456&amp;cid=C04ABCDEF">10:42 AM</a></div><div>ping me</div>`;
    const c = parseClip("Nitin  10:42 AM\nping me", html);
    expect(c.url).toBe(`${LINK}?thread_ts=1764226920.123456&cid=C04ABCDEF`);
    expect(c.messages[0]).toMatchObject({ from: "Nitin", body: "ping me" });
  });

  it("falls back to the HTML when there is no plain text", () => {
    expect(htmlToText("<p>one &amp; two</p><p>three<br>four</p>")).toBe("one & two\nthree\nfour");
    expect(parseClip("", "<p>hello there</p>").messages[0].body).toBe("hello there");
  });
});

describe("clipToItem", () => {
  it("a message from someone else: you owe them, with the date it names", () => {
    const it_ = clipToItem(parseClip(`Nitin Kacharia  10:42 AM\ncan you send the final banner text by Monday? Need it for the launch.\n${LINK}`), ctx)!;
    expect(it_).toMatchObject({ kind: "owe", person: "Nitin Kacharia", text: "Can you send the final banner text by Monday?" });
    expect(it_.dueAt).toBe("2026-11-30T12:30:00.000Z"); // 18:00 in Kolkata
    expect(it_.origin).toMatchObject({ app: "slack", url: LINK, from: "Nitin Kacharia", workspace: "acme" });
  });

  it("a thread: the last message someone else wrote is the ask", () => {
    const it_ = clipToItem(parseClip("Priya  9:05 AM\nShipping today\nMaruthi Ram  9:07 AM\nnice\nTarun  9:10 AM\nCan you review my PR?\nMaruthi Ram  9:12 AM\nlooking"), ctx)!;
    expect(it_).toMatchObject({ kind: "owe", person: "Tarun", text: "Can you review my PR?" });
    expect(it_.full).toContain("Priya · 9:05 AM\nShipping today");
  });

  it("a thread: the ask wins over a later thank-you, and the asking sentence is the title", () => {
    const it_ = clipToItem(parseClip("Nitin  10:42 AM\nEarnings tag is live on staging. Can you send the final banner text by Monday? Need it soon.\nMaruthi Ram  10:45 AM\nsure\nNitin  10:46 AM\nthanks! also loop in Jit"), ctx)!;
    expect(it_).toMatchObject({ person: "Nitin", text: "Can you send the final banner text by Monday?" });
    expect(it_.dueAt).toBe("2026-11-30T12:30:00.000Z");
  });

  it("your own ask: you wait on the person you mentioned", () => {
    expect(clipToItem(parseClip("Maruthi Ram  9:07 AM\n@Priya can you send me the notes tomorrow"), ctx)).toMatchObject({ kind: "waiting", person: "Priya", dueAt: "2026-11-28T12:30:00.000Z" });
  });

  it("your own promise: you owe it", () => {
    expect(clipToItem(parseClip("Maruthi  9:07 AM\n@Jit I'll share the deck on Friday"), ctx)).toMatchObject({ kind: "owe", person: "Jit" });
  });

  it("plain text with no Slack headers is still captured", () => {
    const it_ = clipToItem(parseClip("Book the venue for the offsite"), ctx)!;
    expect(it_).toMatchObject({ kind: "owe", person: null, text: "Book the venue for the offsite", origin: { app: "clipboard" } });
  });

  it("only a link: an item to go back to the message", () => {
    expect(clipToItem(parseClip(LINK), ctx)).toMatchObject({ text: "Follow up on this Slack message", origin: { url: LINK } });
  });

  it("nothing copied: no item", () => {
    expect(clipToItem(parseClip("   "), ctx)).toBeNull();
  });

  it("cuts long messages and drops Slack formatting from the title", () => {
    const long = "*Heads up* :rocket: " + "word ".repeat(80);
    const it_ = clipToItem(parseClip(`Jit  1:00 PM\n${long}`), ctx)!;
    expect(it_.text.startsWith("Heads up word")).toBe(true);
    expect(it_.text.length).toBeLessThanOrEqual(140);
    expect(it_.quote.length).toBeLessThanOrEqual(200);
  });
});
