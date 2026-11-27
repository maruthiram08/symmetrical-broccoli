// Capture from the clipboard: turn what you copied (usually Slack messages) into one item, locally,
// with no AI and nothing connected to Slack. The Mac app's shortcut reads the clipboard and posts it
// to /api/capture/clipboard, which calls clipToItem.
//
// What Slack puts on the clipboard:
// - Copying selected messages: plain text with a header per message, "Nitin Kacharia  10:42 AM"
//   (or the name and the time on two lines, or "Nitin [10:42 AM]"), then the message. The HTML
//   copy carries each message's permalink on its time.
// - "Copy link": just the permalink, https://acme.slack.com/archives/C0123ABC/p1732681320123456.
// Anything else copied (an email line, a note) is captured as plain text.

import { parseDue } from "@/lib/capture/parse";
import { zonedTime } from "@/lib/brief/time";
import { DUE_TIME } from "@/lib/capture/parse";

export interface ClipMessage {
  /** Who wrote it, as Slack showed the name. Null when the copy had no header. */
  from: string | null;
  /** "10:42 AM" as shown, when the header had one. */
  time: string | null;
  body: string;
}

export interface ParsedClip {
  /** True when it came from Slack (a permalink or Slack's message headers). */
  slack: boolean;
  messages: ClipMessage[];
  /** The first Slack permalink found (the HTML copy has one per message). */
  url: string | null;
  /** The workspace in the permalink: "acme" in acme.slack.com. */
  workspace: string | null;
  /** When the message was sent, from the permalink's p-timestamp. UTC ISO. */
  sentAt: string | null;
}

const PERMALINK = /https:\/\/([a-z0-9-]+(?:\.enterprise)?)\.slack\.com\/archives\/[A-Z0-9]+\/p(\d{10})(\d{6})?[^\s"'<>)]*/i;
const TIME = String.raw`\d{1,2}:\d{2}(?:\s?[AaPp]\.?[Mm]\.?)?`;
const NAME = String.raw`[\p{L}][\p{L}\p{M}'’.\- ]{0,58}[\p{L}\p{M}.]`;
/** "Nitin Kacharia  10:42 AM", "Nitin Kacharia [10:42 AM]", "Nitin Kacharia APP 10:42". */
const HEADER_ONE = new RegExp(String.raw`^(${NAME})(?:\s+APP)?\s*(?:\[\s*(${TIME})\s*\]|\s{1,}(${TIME}))\s*$`, "u");
const NAME_ONLY = new RegExp(String.raw`^(${NAME})(?:\s+APP)?$`, "u");
const TIME_ONLY = new RegExp(String.raw`^\[?(${TIME})\]?$`, "u");

/** Slack's chrome that a copy picks up: reactions, reply counts, "(edited)", day dividers. */
const NOISE = [
  /^\d+\s+repl(?:y|ies)\b.*$/i,
  /^(?:view thread|last reply .*|view newer replies|show more|see more|new)$/i,
  /^(?::[a-z0-9_+-]+:\s*\d*\s*)+$/i,
  /^(?:today|yesterday|(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:,\s+\w+\s+\d{1,2}(?:st|nd|rd|th)?)?)$/i,
  /^also sent to the channel$/i,
  /^replied to a thread:.*$/i,
];

/** Words that end a sentence like "Let's meet at 10:30", never a display name. */
const NOT_NAME_END = /\b(?:at|by|around|before|after|till|until|from|to|on|is|was|be|meet|call|ok|okay|done)$/i;

/** A header's name: at most four words, and not the start of a sentence ending in a time. */
function looksLikeName(name: string): boolean {
  const words = name.trim().split(/\s+/);
  if (words.length > 4 || NOT_NAME_END.test(name.trim())) return false;
  // "Nitin Kacharia", "nitin.k", "Priya": several words must be capitalised.
  return words.length === 1 || words.every((w) => /^[\p{Lu}]/u.test(w));
}

/** Plain text from Slack's HTML copy, keeping line breaks between blocks. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|h\d|pre|blockquote|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Read what was copied. `html` is the clipboard's HTML flavour, when there was one. */
export function parseClip(text: string, html?: string | null): ParsedClip {
  const plain = (text || (html ? htmlToText(html) : "")).replace(/\r\n?/g, "\n").replace(/ /g, " ").trim();
  const link = (html && html.match(PERMALINK)) || plain.match(PERMALINK);
  const url = link ? link[0].replace(/&amp;/g, "&") : null;
  const workspace = link ? link[1].replace(/\.enterprise$/i, "") : null;
  const sentAt = link ? new Date(Number(link[2]) * 1000).toISOString() : null;

  // Drop the permalink itself from the text (a "Copy link" clip is only that).
  const withoutLink = url ? plain.split(url).join("").trim() : plain;
  const lines = withoutLink.split("\n").map((l) => l.replace(/\s+$/, ""));
  const messages: ClipMessage[] = [];
  let cur: ClipMessage | null = null;
  const push = () => { if (cur && cur.body.trim()) messages.push({ ...cur, body: cur.body.trim() }); };
  for (let k = 0; k < lines.length; k++) {
    const raw = lines[k].trim();
    if (!raw) { if (cur) cur.body += "\n"; continue; }
    if (NOISE.some((re) => re.test(raw))) continue;
    const one = raw.match(HEADER_ONE);
    if (one && looksLikeName(one[1])) { push(); cur = { from: one[1].trim(), time: (one[2] ?? one[3]).trim(), body: "" }; continue; }
    // The name on its own line, the time on the next.
    const next = lines[k + 1]?.trim() ?? "";
    if (NAME_ONLY.test(raw) && TIME_ONLY.test(next) && looksLikeName(raw.replace(/\s+APP$/, ""))) {
      push();
      cur = { from: raw.replace(/\s+APP$/, "").trim(), time: next.match(TIME_ONLY)![1], body: "" };
      k++;
      continue;
    }
    // A bare time line under the same sender (Slack shows times on hover for follow-ups).
    if (cur && TIME_ONLY.test(raw)) { push(); cur = { from: cur.from, time: raw.match(TIME_ONLY)![1], body: "" }; continue; }
    if (!cur) cur = { from: null, time: null, body: "" };
    cur.body += (cur.body && !cur.body.endsWith("\n") ? "\n" : "") + raw;
  }
  push();
  const slack = !!url || messages.some((m) => m.from);
  return { slack, messages, url, workspace, sentAt };
}

export interface ClipItem {
  kind: "owe" | "waiting";
  text: string;
  person: string | null;
  dueAt: string | null;
  /** The message the item came from, as copied (cut to 200 characters). */
  quote: string;
  /** The whole clip, for the item's page. */
  full: string;
  origin: {
    app: "slack" | "clipboard";
    url: string | null;
    from: string | null;
    sentAt: string | null;
    workspace: string | null;
  };
}

export interface ClipContext {
  /** Your name and aliases (a message from you is something you asked or promised). */
  self: string[];
  now: Date;
  timeZone: string;
  /** Today in your zone, "YYYY-MM-DD". */
  today: string;
}

const fold = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const first = (s: string) => fold(s).split(" ")[0];

/** A name is you when it is your name or alias, or its first name is your first name. */
function isSelf(name: string | null, self: string[]): boolean {
  if (!name) return false;
  const n = fold(name);
  return self.some((s) => s.trim() && (fold(s) === n || first(s) === first(n)));
}

const MENTION_STOP = /^(?:I|Can|Could|Would|Will|Please|Pls|Plz|Thanks|Thank|Hi|Hey|Hello|Any|Do|Did|Is|Are|Just|Also|So|And|But|The|This|That|We|You|FYI|Quick|When|What|Where|Why|How|Ok|Okay)$/;

/** "@Nitin Kacharia can you…" -> "Nitin Kacharia". Slack copies mentions as "@Name". */
function firstMention(body: string, self: string[]): string | null {
  for (const m of body.matchAll(/@([\p{L}][\p{L}'’._-]*)(?:\s([\p{Lu}][\p{L}.-]*))?/gu)) {
    // "@Nitin Kacharia" is one name; "@Priya Can you", "@Jit I'll" are not.
    const name = m[2] && !MENTION_STOP.test(m[2]) ? `${m[1]} ${m[2]}` : m[1];
    if (!isSelf(name, self) && !/^(?:here|channel|everyone)$/i.test(m[1])) return name.trim();
  }
  return null;
}

/** A message that asks for something: the one a copied thread is about. */
const ASK = /\?|\b(?:can|could|would|will) you\b|\b(?:please|pls|plz|kindly|need you to|need it|by (?:eod|tomorrow|today|mon|tue|wed|thu|fri)|asap|when can)\b/i;

const PROMISE = /\b(?:i'?ll|i will|i'm going to|i am going to|let me|will do|on it|i can do|i'll get|i shall)\b/i;

/** One line for the item: the message's first sentence, without Slack's formatting. */
function headline(body: string): string {
  const flat = body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_~`>]/g, "")
    .replace(/:[a-z0-9_+-]+:/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  // The sentence that asks for something, else the first one.
  const sentences = flat.match(/[^.?!]+(?:[.?!]+|$)/g)?.map((x) => x.trim()).filter(Boolean) ?? [flat];
  const sentence = sentences.find((x) => ASK.test(x)) ?? (sentences[0].length >= 12 || sentences.length === 1 ? sentences[0] : flat.match(/^(.{12,}?[.?!])(?:\s|$)/)?.[1] ?? flat);
  const cut = sentence.length > 140 ? sentence.slice(0, 137).replace(/\s+\S*$/, "") + "…" : sentence;
  return cut ? cut[0].toUpperCase() + cut.slice(1) : cut;
}

/**
 * The item a clip becomes. The message it is about is the last one someone else wrote (in a
 * copied thread, the latest ask), or your own last one when you wrote them all.
 * - From someone else: you owe them a reply or the thing asked.
 * - From you, a promise ("I'll send it Friday"): you owe it, to the first person you @mentioned.
 * - From you, anything else: you are waiting on the first person you @mentioned.
 * A date in the message ("by Friday") becomes the due date.
 */
export function clipToItem(clip: ParsedClip, ctx: ClipContext): ClipItem | null {
  if (!clip.messages.length) {
    if (!clip.url) return null;
    // "Copy link" only: an item to go back to the message.
    return {
      kind: "owe", text: "Follow up on this Slack message", person: null, dueAt: null, quote: "", full: clip.url,
      origin: { app: "slack", url: clip.url, from: null, sentAt: clip.sentAt, workspace: clip.workspace },
    };
  }
  const others = clip.messages.filter((m) => m.from && !isSelf(m.from, ctx.self));
  const msg = others.filter((m) => ASK.test(m.body)).at(-1) ?? others.at(-1) ?? clip.messages.at(-1)!;
  const mine = isSelf(msg.from, ctx.self);
  const due = parseDue(msg.body.replace(/\s+/g, " "), ctx.today);
  const dueAt = due.date ? zonedTime(due.date, DUE_TIME, ctx.timeZone).toISOString() : null;
  let kind: "owe" | "waiting" = "owe";
  let person: string | null = msg.from && !mine ? msg.from : null;
  if (mine || !msg.from) {
    const mention = firstMention(msg.body, ctx.self);
    if (mine && !PROMISE.test(msg.body) && mention) kind = "waiting";
    person = mention;
  }
  const text = headline(msg.body) || "Follow up on this message";
  const quote = msg.body.replace(/\s+/g, " ").trim();
  const full = clip.messages.map((m) => (m.from ? `${m.from}${m.time ? ` · ${m.time}` : ""}\n${m.body}` : m.body)).join("\n\n");
  return {
    kind, text, person, dueAt,
    quote: quote.length > 200 ? quote.slice(0, 199) + "…" : quote,
    full: full.length > 4000 ? full.slice(0, 3999) + "…" : full,
    origin: {
      app: clip.slack ? "slack" : "clipboard",
      url: clip.url,
      from: msg.from,
      sentAt: clip.sentAt,
      workspace: clip.workspace,
    },
  };
}
