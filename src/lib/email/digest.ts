// Email for the evening wrap and the Friday recap: the same look as the brief email (render.ts),
// built from a Digest. Tables, inline styles, no images, every piece of text escaped.
import { digestText, findName, type Digest, type DigestLine } from "@/lib/channels/digest";
import { escapeHtml as esc, type RenderedEmail } from "./render";

const SANS = "'Instrument Sans',-apple-system,'Segoe UI',system-ui,Roboto,Helvetica,Arial,sans-serif";
const MONO = "'Geist Mono',ui-monospace,'SF Mono',Menlo,Consolas,monospace";
const INK = "#0a0a0a";
const MUTED = "#525252";
const FAINT = "#666666";
const BORDER = "#ececec";
const LATE = "#c4320a";
const HL = "#d6ff3d";

const t = (size: number, lh: number, weight: number, color: string, family = SANS) =>
  `font-family:${family};font-size:${size}px;line-height:${lh}px;font-weight:${weight};color:${color};`;

function text(l: DigestLine): string {
  const hit = findName(l.text, l.person);
  const body = hit ? `${esc(l.text.slice(0, hit.start))}<b style="font-weight:600;">${esc(l.text.slice(hit.start, hit.end))}</b>${esc(l.text.slice(hit.end))}` : esc(l.text);
  return l.done ? `<span style="color:${FAINT};text-decoration:line-through;">${body}</span>` : body;
}

function line(l: DigestLine, last: boolean): string {
  const side = l.side ? `<span style="${t(12, 24, l.late ? 500 : 400, l.late ? LATE : FAINT, MONO)}white-space:nowrap;">${esc(l.side)}</span>` : "";
  const under = [l.quote ? `<span style="color:${MUTED};">&quot;${esc(l.quote)}&quot;</span>` : "", l.source ? `<span style="color:${FAINT};">${esc(l.source)}</span>` : ""]
    .filter(Boolean)
    .join(` <span style="color:${FAINT};">&middot;</span> `);
  return (
    `<tr><td style="padding:12px 0;${last ? "" : `border-bottom:1px solid ${BORDER};`}">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr>` +
    `<td valign="top" style="${t(16, 24, 500, INK)}">${text(l)}</td>` +
    `<td valign="top" align="right" style="padding-left:12px;white-space:nowrap;">${side}</td></tr>` +
    (under ? `<tr><td colspan="2" style="padding-top:4px;${t(13, 18, 400, MUTED)}">${under}</td></tr>` : "") +
    `</table></td></tr>`
  );
}

export function renderDigestEmail(d: Digest, link?: string): RenderedEmail {
  const rows: string[] = [];
  rows.push(`<tr><td><div style="${t(32, 38, 600, INK)}letter-spacing:-0.03em;">${esc(d.title)}</div></td></tr>`);
  if (d.stats) rows.push(`<tr><td style="padding:8px 0 0 0;${t(13, 18, 400, MUTED, MONO)}">${esc(d.stats)}</td></tr>`);
  if (d.big) rows.push(`<tr><td style="padding:28px 0 0 0;${t(26, 32, 600, INK)}">${esc(d.big)}</td></tr>`);
  for (const s of d.sections) {
    rows.push(
      `<tr><td style="padding:28px 0 0 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">` +
      `<tr><td style="padding:0 0 8px 0;border-bottom:1px solid ${BORDER};"><span style="${t(20, 26, 600, INK)}">${esc(s.title)}</span>` +
      `<span style="${t(12, 16, 400, FAINT, MONO)}">&nbsp;&nbsp;${esc(s.count)}</span></td></tr>` +
      s.lines.map((l, i) => line(l, i === s.lines.length - 1)).join("") +
      (s.more ? `<tr><td style="padding:10px 0 0 0;${t(13, 18, 400, FAINT)}">${esc(s.more)}</td></tr>` : "") +
      `</table></td></tr>`,
    );
  }
  const href = link && /^https?:\/\//i.test(link) ? esc(link) : null;
  rows.push(
    `<tr><td style="padding:36px 0 0 0;"><span style="display:inline-block;width:10px;height:10px;background-color:${HL};border:1px solid ${INK};border-radius:3px;font-size:0;line-height:0;vertical-align:middle;">&nbsp;</span>` +
    (href ? `<a href="${href}" style="${t(12, 16, 600, FAINT)}text-decoration:none;vertical-align:middle;">&nbsp;&nbsp;Daily brief</a>` : `<span style="${t(12, 16, 600, FAINT)}vertical-align:middle;">&nbsp;&nbsp;Daily brief</span>`) +
    `</td></tr>`,
  );
  const html =
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="light"><title>${esc(d.subject)}</title></head>` +
    `<body style="margin:0;padding:0;background-color:#ffffff;">` +
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(d.summary)}</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr><td align="center">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;max-width:600px;width:100%;"><tr>` +
    `<td style="padding:40px 24px;text-align:left;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">${rows.join("")}</table>` +
    `</td></tr></table></td></tr></table></body></html>`;
  return { subject: d.subject, html, text: digestText(d, link) };
}
