// Telegram message (HTML parse mode) for a digest. Quotes sit in an expandable blockquote per section,
// collapsed until tapped. Numbered items can be closed with "/done 3" when replies are on.
import { findName, type Digest, type DigestLine } from "./digest";

export const TELEGRAM_MAX = 4096;

export function tgEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function lineHtml(l: DigestLine): string {
  const hit = findName(l.text, l.person);
  const body = hit
    ? `${tgEscape(l.text.slice(0, hit.start))}<b>${tgEscape(l.text.slice(hit.start, hit.end))}</b>${tgEscape(l.text.slice(hit.end))}`
    : tgEscape(l.text);
  const text = l.done ? `<s>${body}</s>` : body;
  return `${l.n ? `${l.n}.` : "•"} ${text}${l.side ? ` · <code>${tgEscape(l.side)}</code>` : ""}`;
}

function build(d: Digest, withQuotes: boolean, opts: { replies?: boolean; link?: string; prefix?: string }): string {
  const out: string[] = [`<b>${tgEscape(`${opts.prefix ?? ""}${d.title}`)}</b>`];
  if (d.stats) out.push(`<i>${tgEscape(d.stats)}</i>`);
  if (d.big) out.push("", `<b>${tgEscape(d.big)}</b>`);
  for (const s of d.sections) {
    out.push("", `<b>${tgEscape(s.title)}</b> · ${tgEscape(s.count)}`);
    out.push(...s.lines.map(lineHtml));
    const quotes = s.lines.filter((l) => l.quote).map((l) => `${l.n ? `${l.n}. ` : ""}“${tgEscape(l.quote!)}”${l.source ? ` · ${tgEscape(l.source)}` : ""}`);
    if (withQuotes && quotes.length) out.push(`<blockquote expandable>${quotes.join("\n")}</blockquote>`);
    if (s.more) out.push(`<i>${tgEscape(s.more)}</i>`);
  }
  if (opts.replies && d.numbers.length) out.push("", `<i>Reply /done ${Math.min(3, d.numbers.length)} to close item ${Math.min(3, d.numbers.length)}.</i>`);
  if (opts.link && /^https?:\/\//.test(opts.link)) out.push("", `<a href="${tgEscape(opts.link).replace(/"/g, "&quot;")}">Open Daily brief</a>`);
  return out.join("\n");
}

export function telegramText(d: Digest, opts: { replies?: boolean; link?: string; prefix?: string } = {}): string {
  const full = build(d, true, opts);
  if (full.length <= TELEGRAM_MAX) return full;
  const lean = build(d, false, opts);
  if (lean.length <= TELEGRAM_MAX) return lean;
  // Still too long: cut at a line break (never inside a tag pair, since each line closes its own tags).
  const cut = lean.slice(0, TELEGRAM_MAX - 40);
  return `${cut.slice(0, cut.lastIndexOf("\n"))}\n<i>More in your daily note.</i>`;
}

/** "/done 3", "/done@MyBriefBot 3", "done 3". Returns the number, or null. */
export function parseDone(text: string): number | null {
  const m = /^\/?done(?:@\w+)?\s+#?(\d{1,3})\s*$/i.exec(text.trim());
  return m ? Number(m[1]) : null;
}
