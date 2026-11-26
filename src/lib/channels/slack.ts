// Slack Block Kit for a digest. Items stay short in the message; their quotes go in one attachment,
// which Slack shows collapsed ("Show more") once it is longer than a few lines.
import { findName, type Digest, type DigestLine } from "./digest";

export interface SlackMessage {
  text: string;
  blocks: Array<Record<string, unknown>>;
  attachments?: Array<Record<string, unknown>>;
}

/** Slack's mrkdwn needs only &, < and > escaped. */
export function slackEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const SECTION_MAX = 2900; // Slack's limit is 3000 characters per text field
const MAX_BLOCKS = 45; // of 50

function lineText(l: DigestLine): string {
  const hit = findName(l.text, l.person);
  const body = hit
    ? `${slackEscape(l.text.slice(0, hit.start))}*${slackEscape(l.text.slice(hit.start, hit.end))}*${slackEscape(l.text.slice(hit.end))}`
    : slackEscape(l.text);
  const text = l.done ? `~${body}~` : body;
  const side = l.side ? `  \`${slackEscape(l.side)}\`` : "";
  return `${l.n ? `${l.n}.` : "•"} ${text}${side}`;
}

/** Split lines into section texts under Slack's per-field limit. */
function chunks(lines: string[], max = SECTION_MAX): string[] {
  const out: string[] = [];
  let cur = "";
  for (const l of lines) {
    const piece = l.length > max ? `${l.slice(0, max - 1)}…` : l;
    if (cur && cur.length + 1 + piece.length > max) {
      out.push(cur);
      cur = piece;
    } else cur = cur ? `${cur}\n${piece}` : piece;
  }
  if (cur) out.push(cur);
  return out;
}

const mrkdwn = (text: string) => ({ type: "section", text: { type: "mrkdwn", text } });

export function slackMessage(d: Digest, opts: { link?: string; prefix?: string } = {}): SlackMessage {
  const blocks: Array<Record<string, unknown>> = [];
  blocks.push({ type: "header", text: { type: "plain_text", text: `${opts.prefix ?? ""}${d.title}`.slice(0, 150), emoji: false } });
  if (d.stats) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: slackEscape(d.stats) }] });
  if (d.big) blocks.push(mrkdwn(`*${slackEscape(d.big)}*`));
  for (const s of d.sections) {
    blocks.push({ type: "divider" });
    blocks.push(mrkdwn(`*${slackEscape(s.title)}*  ·  ${slackEscape(s.count)}`));
    for (const c of chunks(s.lines.map(lineText))) blocks.push(mrkdwn(c));
    if (s.more) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: slackEscape(s.more) }] });
  }
  if (opts.link && /^https?:\/\//.test(opts.link)) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `<${opts.link}|Open Daily brief>` }] });
  }
  if (blocks.length > MAX_BLOCKS) {
    blocks.length = MAX_BLOCKS - 1;
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: "More in your daily note." }] });
  }

  const quotes = d.sections.flatMap((s) =>
    s.lines
      .filter((l) => l.quote)
      .map((l) => `${l.n ? `${l.n}. ` : ""}> “${slackEscape(l.quote!)}”${l.source ? `  _${slackEscape(l.source)}_` : ""}`),
  );
  const attachments = quotes.length
    ? [{ color: "#d6ff3d", fallback: "Quotes", blocks: chunks(["*Quotes*", ...quotes]).slice(0, 4).map(mrkdwn) }]
    : undefined;

  return { text: `${opts.prefix ?? ""}${d.subject}`, blocks, ...(attachments ? { attachments } : {}) };
}
