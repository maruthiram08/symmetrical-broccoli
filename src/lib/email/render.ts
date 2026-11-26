// Renders a BriefModel to an email-safe HTML document and a plain-text version.
// Email rules: tables for layout, inline styles only (a small <style> block adds dark mode and phone
// tweaks for clients that support it), no images, max width 600px. All model text is escaped.
import type { BriefLine, BriefModel, ClosedLine } from "@/lib/types";

export interface EmailLinks {
  base: string;
  actionUrl(itemId: string, action: "done" | "wrong"): string;
  downloadUrl: string;
  deleteUrl: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

// Design tokens (light theme). Dark overrides live in the <style> block below.
const C = {
  bg: "#ffffff",
  ink: "#0a0a0a",
  muted: "#525252",
  faint: "#666666",
  border: "#ececec",
  borderStrong: "#8a8a8a",
  highlight: "#d6ff3d",
  onHighlight: "#0a0a0a",
  overdue: "#c4320a",
  doneDot: "#b8b8b8",
};
const SANS = "'Instrument Sans',-apple-system,'Segoe UI',system-ui,Roboto,Helvetica,Arial,sans-serif";
const MONO = "'Geist Mono',ui-monospace,'SF Mono',Menlo,Consolas,monospace";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
const esc = escapeHtml;

/** Escape for an href; only http(s) and mailto URLs are allowed through. */
function href(url: string): string {
  return /^(https?:|mailto:)/i.test(url) ? esc(url) : "#";
}

function type(size: number, lineHeight: number, weight: number, color: string, family = SANS): string {
  return `font-family:${family};font-size:${size}px;line-height:${lineHeight}px;font-weight:${weight};color:${color};`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Finds the person's name (full, else first name) in the text as a whole word. */
function findName(text: string, person: string): { start: number; end: number } | null {
  const candidates = [person.trim(), person.trim().split(/\s+/)[0]].filter(Boolean);
  for (const name of candidates) {
    const lower = text.toLowerCase();
    const needle = name.toLowerCase();
    let from = 0;
    while (from <= lower.length) {
      const idx = lower.indexOf(needle, from);
      if (idx < 0) break;
      const before = idx === 0 ? "" : text[idx - 1];
      const after = text[idx + name.length] ?? "";
      if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) return { start: idx, end: idx + name.length };
      from = idx + 1;
    }
  }
  return null;
}

/** Item text with the person in bold. In You owe the bold name sits on a lime highlighter fill. */
function itemTextHtml(line: Pick<BriefLine, "text" | "person">, highlight: boolean): string {
  const hit = line.person ? findName(line.text, line.person) : null;
  if (!hit) return esc(line.text);
  const name = esc(line.text.slice(hit.start, hit.end));
  const bold = highlight
    ? `<b class="em-hl" style="font-weight:600;color:${C.onHighlight};background-color:${C.highlight};padding:0 2px;border-radius:2px;">${name}</b>`
    : `<b style="font-weight:600;">${name}</b>`;
  return esc(line.text.slice(0, hit.start)) + bold + esc(line.text.slice(hit.end));
}

type MarkKind = "owe" | "waiting" | "decision" | "overdue" | "done";

function mark(kind: MarkKind): string {
  switch (kind) {
    case "owe":
      return `<span class="em-mark-owe" style="display:inline-block;width:8px;height:8px;background-color:${C.highlight};border:1px solid ${C.ink};border-radius:3px;font-size:0;line-height:0;vertical-align:top;">&nbsp;</span>`;
    case "waiting":
      return `<span class="em-mark-waiting" style="display:inline-block;width:7px;height:7px;border:1.5px solid ${C.muted};border-radius:50%;font-size:0;line-height:0;vertical-align:top;">&nbsp;</span>`;
    case "decision":
      return `<span class="em-ink" style="display:inline-block;font-family:Arial,sans-serif;font-size:11px;line-height:10px;vertical-align:top;color:${C.ink};">&#9670;</span>`;
    case "overdue":
      return `<span class="em-mark-overdue" style="display:inline-block;width:10px;height:10px;background-color:${C.overdue};border-radius:3px;font-size:0;line-height:0;vertical-align:top;">&nbsp;</span>`;
    case "done":
      return `<span style="display:inline-block;width:8px;height:8px;background-color:${C.doneDot};border-radius:50%;font-size:0;line-height:0;vertical-align:top;">&nbsp;</span>`;
  }
}

function lineMark(line: BriefLine): MarkKind {
  if (line.lateLabel) return "overdue";
  return line.kind;
}

function sideLabel(line: BriefLine): string {
  if (line.lateLabel) {
    return `<span class="em-late" style="${type(12, 24, 500, C.overdue, MONO)}white-space:nowrap;">${esc(line.lateLabel)}</span>`;
  }
  if (line.dueLabel) {
    return `<span class="em-faint" style="${type(12, 24, 400, C.faint, MONO)}white-space:nowrap;">${esc(line.dueLabel)}</span>`;
  }
  return "";
}

function source(meetingTitle: string, meetingTime: string): string {
  return [meetingTitle, meetingTime].filter(Boolean).join(", ");
}

function quoteLineHtml(quote: string, meetingTitle: string, meetingTime: string): string {
  const src = source(meetingTitle, meetingTime);
  const q = quote ? `<span class="em-muted" style="color:${C.muted};">&quot;${esc(quote)}&quot;</span>` : "";
  const s = src ? `<span class="em-faint" style="color:${C.faint};">${q ? " &middot; " : ""}${esc(src)}</span>` : "";
  return q + s;
}

function actionLinks(itemId: string, links: EmailLinks, actions: Array<"done" | "wrong">): string {
  const linkStyle = `${type(13, 18, 500, C.muted)}text-decoration:underline;`;
  const parts = actions.map((a) => {
    const label = a === "done" ? "Done" : "Wrong";
    return `<a class="em-muted" href="${href(links.actionUrl(itemId, a))}" style="${linkStyle}">${label}</a>`;
  });
  return parts.join(`<span class="em-faint" style="${type(13, 18, 400, C.faint)}">&nbsp;&nbsp;&middot;&nbsp;&nbsp;</span>`);
}

function row(inner: string, last: boolean): string {
  const border = last ? "" : `border-bottom:1px solid ${C.border};`;
  return `<tr><td class="em-border" style="padding:14px 0;${border}">${inner}</td></tr>`;
}

function itemTable(markHtml: string, textHtml: string, side: string, extraRows: string[]): string {
  const extras = extraRows
    .map((r) => `<tr><td style="font-size:0;line-height:0;">&nbsp;</td><td colspan="2" style="padding-top:4px;${type(13, 18, 400, C.muted)}">${r}</td></tr>`)
    .join("");
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">` +
    `<tr>` +
    `<td width="22" valign="top" style="width:22px;padding-top:7px;line-height:10px;font-size:10px;">${markHtml}</td>` +
    `<td valign="top" class="em-ink" style="${type(16, 24, 500, C.ink)}letter-spacing:-0.01em;">${textHtml}</td>` +
    `<td valign="top" align="right" style="padding-left:12px;white-space:nowrap;">${side}</td>` +
    `</tr>${extras}</table>`
  );
}

function briefItemHtml(line: BriefLine, links: EmailLinks, last: boolean): string {
  const text = itemTextHtml(line, line.kind === "owe");
  const extras = [quoteLineHtml(line.quote, line.meetingTitle, line.meetingTime)].filter(Boolean);
  extras.push(actionLinks(line.itemId, links, line.kind === "decision" ? ["wrong"] : ["done", "wrong"]));
  return row(itemTable(mark(lineMark(line)), text, sideLabel(line), extras), last);
}

function closedQuoteSentence(line: ClosedLine): string {
  // ClosedLine has no speaker yet; use one if the builder starts sending it.
  const who = (line as ClosedLine & { person?: string | null }).person;
  const where = source(line.closedInMeeting, line.closedAtTime);
  const said = who ? `${who} said "${line.closeQuote}"` : `"${line.closeQuote}"`;
  return `Closed: ${said}${where ? ` in ${where}` : ""}.`;
}

function closedItemHtml(line: ClosedLine, last: boolean): string {
  const text = `<span class="em-faint" style="color:${C.faint};text-decoration:line-through;">${esc(line.text)}</span>`;
  return row(itemTable(mark("done"), text, "", [`<span class="em-muted" style="color:${C.muted};">${esc(closedQuoteSentence(line))}</span>`]), last);
}

function stillOpenItemHtml(line: BriefLine, links: EmailLinks, last: boolean): string {
  const src = source(line.meetingTitle, line.meetingTime);
  const extras = [src ? `<span class="em-faint" style="color:${C.faint};">${esc(src)}</span>` : "", actionLinks(line.itemId, links, ["done", "wrong"])].filter(Boolean);
  return row(itemTable(mark(lineMark(line)), itemTextHtml(line, line.kind === "owe"), sideLabel(line), extras), last);
}

function sectionHtml(title: string, count: string, rows: string): string {
  return (
    `<tr><td style="padding:32px 0 0 0;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">` +
    `<tr><td class="em-border" style="padding:0 0 8px 0;border-bottom:1px solid ${C.border};">` +
    `<span class="em-ink" style="${type(20, 26, 600, C.ink)}letter-spacing:-0.02em;">${esc(title)}</span>` +
    `<span class="em-faint" style="${type(12, 16, 400, C.faint, MONO)}">&nbsp;&nbsp;${esc(count)}</span>` +
    `</td></tr>${rows}</table></td></tr>`
  );
}

function wrapHtml(w: BriefModel["wrap"]): string {
  const cell = (n: number, label: string, variant: "plain" | "kept" | "late") => {
    const bg = variant === "kept" ? `background-color:${C.highlight};` : "";
    const cls = variant === "kept" ? "em-hl-cell" : "em-border";
    const border = variant === "kept" ? `border:1px solid ${C.highlight};` : `border:1px solid ${C.border};`;
    const numColor = variant === "late" ? C.overdue : variant === "kept" ? C.onHighlight : C.ink;
    const numCls = variant === "late" ? "em-late" : variant === "kept" ? "em-on-hl" : "em-ink";
    const labelColor = variant === "kept" ? C.onHighlight : C.muted;
    const labelCls = variant === "kept" ? "em-on-hl" : "em-muted";
    return (
      `<td class="${cls}" width="25%" valign="top" style="width:25%;padding:12px 12px 10px 12px;border-radius:8px;${bg}${border}">` +
      `<div class="${numCls}" style="${type(28, 32, 500, numColor, MONO)}letter-spacing:-0.02em;">${n}</div>` +
      `<div class="${labelCls}" style="${type(12, 16, 500, labelColor)}padding-top:2px;">${esc(label)}</div></td>`
    );
  };
  const gap = `<td width="8" style="width:8px;font-size:0;line-height:0;">&nbsp;</td>`;
  return (
    `<tr><td style="padding:24px 0 0 0;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;table-layout:fixed;"><tr>` +
    cell(w.meetings, w.meetings === 1 ? "Meeting" : "Meetings", "plain") + gap +
    cell(w.made, "Promises made", "plain") + gap +
    cell(w.kept, "Kept", "kept") + gap +
    cell(w.late, "Late", w.late > 0 ? "late" : "plain") +
    `</tr></table></td></tr>`
  );
}

function bigLine(text: string): string {
  return `<tr><td style="padding:32px 0 0 0;"><div class="em-ink em-big" style="${type(32, 36, 600, C.ink)}letter-spacing:-0.03em;">${esc(text)}</div></td></tr>`;
}

function openCountForNoMeetings(m: BriefModel): number {
  return m.youOwe.length + m.waitingOn.length + m.stillOpenCount;
}

function fromLine(m: BriefModel): string {
  return `From ${plural(m.meetingCount, "meeting", "meetings")} today`;
}

function noMeetingsLine(m: BriefModel): string {
  return `No meetings today. ${plural(openCountForNoMeetings(m), "item", "items")} still open.`;
}

function preheader(m: BriefModel): string {
  if (m.empty === "no_meetings") return noMeetingsLine(m);
  const parts: string[] = [];
  const late = m.youOwe.filter((l) => l.lateLabel).length;
  if (m.youOwe.length) parts.push(`You owe ${m.youOwe.length}${late ? ` (${late} late)` : ""}`);
  if (m.waitingOn.length) parts.push(`waiting on ${m.waitingOn.length}`);
  if (m.decisions.length) parts.push(plural(m.decisions.length, "decision", "decisions"));
  if (m.closedToday.length) parts.push(`${m.closedToday.length} closed`);
  if (!parts.length) return "Nothing owed. Go home.";
  const s = parts.join(", ");
  return s[0].toUpperCase() + s.slice(1) + ".";
}

const STYLE = `
:root{color-scheme:light dark;supported-color-schemes:light dark}
body{margin:0;padding:0;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
a{color:inherit}
@media (max-width:480px){
  .em-pad{padding:32px 16px 32px 16px!important}
  .em-title{font-size:34px!important;line-height:38px!important}
  .em-big{font-size:28px!important;line-height:32px!important}
}
@media (prefers-color-scheme:dark){
  body,.em-body,.em-bg{background-color:#0b0b0c!important}
  .em-ink{color:#f4f4f5!important}
  .em-muted{color:#a1a1aa!important}
  .em-faint{color:#8b8b94!important}
  .em-border{border-color:#1f1f23!important}
  .em-late{color:#ff6b4a!important}
  .em-mark-overdue{background-color:#ff6b4a!important}
  .em-mark-waiting{border-color:#a1a1aa!important}
  .em-mark-owe{border-color:#0a0a0a!important}
  .em-hl,.em-on-hl{color:#0a0a0a!important}
}
[data-ogsc] .em-ink{color:#f4f4f5!important}
[data-ogsc] .em-muted{color:#a1a1aa!important}
[data-ogsc] .em-faint{color:#8b8b94!important}
[data-ogsc] .em-late{color:#ff6b4a!important}
`;

export function renderEmail(model: BriefModel, links: EmailLinks): RenderedEmail {
  const subject = model.subject;
  const rows: string[] = [];

  // Title and the one line under it.
  rows.push(
    `<tr><td><div class="em-ink em-title" style="${type(40, 44, 600, C.ink)}letter-spacing:-0.035em;margin:0;">${esc(model.dateLabel)}</div></td></tr>`,
  );
  if (model.empty === "no_meetings") {
    rows.push(bigLine(noMeetingsLine(model)));
  } else {
    rows.push(`<tr><td style="padding:8px 0 0 0;"><div class="em-muted" style="${type(13, 18, 400, C.muted)}">${esc(fromLine(model))}</div></td></tr>`);
    rows.push(wrapHtml(model.wrap));
  }

  if (model.empty === "nothing_owed") rows.push(bigLine("Nothing owed. Go home."));

  const list = <T>(items: T[], f: (x: T, last: boolean) => string) => items.map((x, i) => f(x, i === items.length - 1)).join("");

  if (model.youOwe.length) {
    rows.push(sectionHtml("You owe", `${model.youOwe.length} open`, list(model.youOwe, (l, last) => briefItemHtml(l, links, last))));
  }
  if (model.waitingOn.length) {
    rows.push(sectionHtml("Waiting on", `${model.waitingOn.length} open`, list(model.waitingOn, (l, last) => briefItemHtml(l, links, last))));
  }
  if (model.decisions.length) {
    rows.push(sectionHtml("Decisions", `${model.decisions.length} today`, list(model.decisions, (l, last) => briefItemHtml(l, links, last))));
  }
  if (model.closedToday.length) {
    rows.push(sectionHtml("Closed today", `${model.closedToday.length} closed`, list(model.closedToday, (l, last) => closedItemHtml(l, last))));
  }
  if (model.stillOpenCount > 0) {
    const shown = model.stillOpen.slice(0, 5);
    const more = model.stillOpenCount - shown.length;
    const moreRow = more > 0
      ? `<tr><td style="padding:12px 0 0 0;"><span class="em-faint" style="${type(13, 18, 400, C.faint)}">And ${more} more. Your notes have the full list.</span></td></tr>`
      : "";
    rows.push(
      sectionHtml(
        "Still open from before",
        plural(model.stillOpenCount, "item", "items"),
        list(shown, (l, last) => stillOpenItemHtml(l, links, last && !moreRow)) + moreRow,
      ),
    );
  }

  // Footer.
  const footLink = `${type(13, 18, 500, C.muted)}text-decoration:underline;`;
  rows.push(
    `<tr><td class="em-border" style="padding:40px 0 0 0;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr><td class="em-border" style="padding:16px 0 0 0;border-top:1px solid ${C.border};">` +
    `<a class="em-muted" href="${href(links.downloadUrl)}" style="${footLink}">Download my notes</a>` +
    `<span class="em-faint" style="${type(13, 18, 400, C.faint)}">&nbsp;&nbsp;&middot;&nbsp;&nbsp;</span>` +
    `<a class="em-muted" href="${href(links.deleteUrl)}" style="${footLink}">Delete my data</a>` +
    `</td></tr><tr><td style="padding:12px 0 0 0;">` +
    `<span style="display:inline-block;width:10px;height:10px;background-color:${C.highlight};border:1px solid ${C.ink};border-radius:3px;font-size:0;line-height:0;vertical-align:middle;">&nbsp;</span>` +
    `<a class="em-faint" href="${href(links.base)}" style="${type(12, 16, 600, C.faint)}text-decoration:none;vertical-align:middle;">&nbsp;&nbsp;Daily brief</a>` +
    `</td></tr></table></td></tr>`,
  );

  const html =
    `<!DOCTYPE html><html lang="en" xmlns="http://www.w3.org/1999/xhtml"><head>` +
    `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">` +
    `<meta name="x-apple-disable-message-reformatting">` +
    `<title>${esc(subject)}</title>` +
    `<link rel="preconnect" href="https://fonts.googleapis.com">` +
    `<link href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600&amp;family=Geist+Mono:wght@400;500&amp;display=swap" rel="stylesheet">` +
    `<style>${STYLE}</style></head>` +
    `<body class="em-body" style="margin:0;padding:0;background-color:${C.bg};">` +
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${esc(preheader(model))}</div>` +
    `<table role="presentation" class="em-bg" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;background-color:${C.bg};"><tr><td align="center">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;max-width:600px;width:100%;"><tr>` +
    `<td class="em-pad" style="padding:48px 24px 40px 24px;text-align:left;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">${rows.join("")}</table>` +
    `</td></tr></table></td></tr></table></body></html>`;

  return { subject, html, text: renderText(model, links) };
}

function textItem(line: BriefLine, links: EmailLinks, actions: Array<"done" | "wrong">, withQuote: boolean): string[] {
  const side = line.lateLabel ?? line.dueLabel;
  const out = [`- ${line.text}${side ? ` (${side})` : ""}`];
  const src = source(line.meetingTitle, line.meetingTime);
  if (withQuote && line.quote) out.push(`  "${line.quote}"${src ? ` · ${src}` : ""}`);
  else if (src) out.push(`  ${src}`);
  for (const a of actions) out.push(`  ${a === "done" ? "Done" : "Wrong"}: ${links.actionUrl(line.itemId, a)}`);
  return out;
}

export function renderText(model: BriefModel, links: EmailLinks): string {
  const out: string[] = [model.dateLabel];
  if (model.empty === "no_meetings") {
    out.push("", noMeetingsLine(model));
  } else {
    out.push(fromLine(model), "");
    const w = model.wrap;
    out.push(`${plural(w.meetings, "meeting", "meetings")} · ${w.made} promises made · ${w.kept} kept · ${w.late} late`);
  }
  if (model.empty === "nothing_owed") out.push("", "Nothing owed. Go home.");

  const section = (title: string, count: string, lines: string[][]) => {
    out.push("", `${title} (${count})`, "");
    lines.forEach((l, i) => {
      out.push(...l);
      if (i < lines.length - 1) out.push("");
    });
  };
  if (model.youOwe.length) section("You owe", `${model.youOwe.length} open`, model.youOwe.map((l) => textItem(l, links, ["done", "wrong"], true)));
  if (model.waitingOn.length) section("Waiting on", `${model.waitingOn.length} open`, model.waitingOn.map((l) => textItem(l, links, ["done", "wrong"], true)));
  if (model.decisions.length) section("Decisions", `${model.decisions.length} today`, model.decisions.map((l) => textItem(l, links, ["wrong"], true)));
  if (model.closedToday.length) {
    section("Closed today", `${model.closedToday.length} closed`, model.closedToday.map((c) => [`- [closed] ${c.text}`, `  ${closedQuoteSentence(c)}`]));
  }
  if (model.stillOpenCount > 0) {
    const shown = model.stillOpen.slice(0, 5);
    section("Still open from before", plural(model.stillOpenCount, "item", "items"), shown.map((l) => textItem(l, links, ["done", "wrong"], false)));
    const more = model.stillOpenCount - shown.length;
    if (more > 0) out.push("", `And ${more} more. Your notes have the full list.`);
  }
  out.push("", "--", `Download my notes: ${links.downloadUrl}`, `Delete my data: ${links.deleteUrl}`, "");
  return out.join("\n");
}
