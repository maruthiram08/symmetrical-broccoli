// A review as one static HTML file to share: inline styles, no scripts, no links back to the app.
// Quotes from meetings are left out unless asked for: they are the people's own words.

import { durationLabel, keptRate, type Review, type ReviewItem } from "./review";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function day(iso: string, tz: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: tz });
}

const CSS = `
:root{--bg:#fff;--ink:#0a0a0a;--muted:#525252;--faint:#666;--border:#ececec;--surface:#fafafa;--hl:#d6ff3d;--on-hl:#0a0a0a;--late:#c4320a;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0b0b0c;--ink:#f4f4f5;--muted:#a1a1aa;--faint:#8b8b94;--border:#1f1f23;--surface:#111113;--late:#ff6b4a;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 "Instrument Sans",-apple-system,"Segoe UI",system-ui,sans-serif}
main{max-width:680px;margin:0 auto;padding:48px 16px 64px}
h1{font-size:32px;line-height:38px;letter-spacing:-.03em;margin:0 0 4px;font-weight:600}
h2{font-size:18px;letter-spacing:-.02em;margin:40px 0 8px;font-weight:600}
.sub{color:var(--muted);margin:0}
.mono{font-family:"Geist Mono",ui-monospace,"SF Mono",Menlo,monospace}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin:28px 0 0;padding:0}
.stat{border:1px solid var(--border);border-radius:14px;padding:12px 14px;margin:0}
.stat dt{color:var(--faint);font-size:12px}.stat dd{margin:2px 0 0;font:500 26px/32px "Geist Mono",ui-monospace,monospace}
.stat--hl{background:var(--hl);border-color:var(--hl);color:var(--on-hl)}.stat--hl dt{color:var(--on-hl);opacity:.7}
.late{color:var(--late)}
.row{display:flex;gap:12px;align-items:baseline;padding:8px 0;border-bottom:1px solid var(--border)}
.row:last-child{border-bottom:0}.row b{font-weight:500;flex:1;min-width:0}
.meta{color:var(--faint);font-size:13px}.q{color:var(--muted);font-size:13px;display:block}
.bars{display:flex;align-items:flex-end;gap:6px;height:120px;margin-top:12px}
.bar{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;gap:4px;min-width:0}
.bar i{display:block;width:100%;max-width:36px;background:var(--ink);border-radius:4px 4px 0 0;min-height:2px}
.bar span{font-size:11px;color:var(--faint);white-space:nowrap}.bar em{font:normal 11px "Geist Mono",monospace;color:var(--muted)}
.empty{color:var(--faint);font-size:13px}
footer{margin-top:48px;color:var(--faint);font-size:12px}
`;

function itemRow(i: ReviewItem, right: string, tz: string, quotes: boolean): string {
  const who = i.person ? ` · ${esc(i.person)}` : "";
  const q = quotes && i.quote ? `<span class="q">&ldquo;${esc(i.quote)}&rdquo;</span>` : "";
  return `<div class="row"><b>${esc(i.text)}<span class="meta">${who} · ${esc(i.meetingTitle)}, ${day(i.madeAt, tz)}</span>${q}</b><span class="mono meta">${right}</span></div>`;
}

export interface HtmlOptions {
  quotes: boolean;
  timeZone: string;
  /** When the file was made, for the footer. */
  now: Date;
}

/** The whole review as a standalone HTML document. */
export function renderReviewHtml(r: Review, o: HtmlOptions): string {
  const c = r.counts;
  const rate = keptRate(c);
  const title = r.period.kind === "year" ? `${r.period.label} in review` : `${r.period.label} review`;
  const stat = (label: string, value: number | string, cls = "") => `<div class="stat ${cls}"><dt>${label}</dt><dd>${value}</dd></div>`;
  const max = Math.max(1, ...r.decisionsBy.map((d) => d.count));
  const bars = r.decisionsBy.map((d) =>
    `<div class="bar"><em>${d.count || ""}</em><i style="height:${Math.round((d.count / max) * 90)}%"></i><span>${esc(d.label)}</span></div>`).join("");
  const people = r.people.length
    ? r.people.map((p) => `<div class="row"><b>${esc(p.name)}</b><span class="mono meta">${p.made} made · ${p.kept} kept${p.open ? ` · ${p.open} open` : ""}</span></div>`).join("")
    : `<p class="empty">No promises to anyone this ${r.period.kind}.</p>`;
  const longest = r.longestOpen.length
    ? r.longestOpen.map((i) => itemRow(i, `${durationLabel(i.openMinutes)}${i.stillOpen ? " · open" : ""}`, o.timeZone, o.quotes)).join("")
    : `<p class="empty">Nothing to show.</p>`;
  const fastest = r.fastestClosed.length
    ? r.fastestClosed.map((i) => itemRow(i, durationLabel(i.openMinutes), o.timeZone, o.quotes)).join("")
    : `<p class="empty">Nothing closed yet.</p>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head>
<body><main>
<h1>${esc(title)}</h1>
<p class="sub">${c.meetings} meetings · ${c.made} promises made · ${rate === null ? "nothing to keep" : `${rate}% kept`}</p>
<dl class="stats">
${stat("Promises made", c.made, "stat--hl")}${stat("Kept", c.kept)}${stat("Late", c.late, c.late ? "late" : "")}${stat("Closed by meetings", c.closedByMeetings)}${stat("Waiting on others", c.waiting)}${stat("Decisions", c.decisions)}
</dl>
<h2>People you promised most</h2>${people}
<h2>Decisions by ${r.period.kind === "year" ? "month" : "week"}</h2><div class="bars">${bars}</div>
<h2>Longest open</h2>${longest}
<h2>Fastest closed</h2>${fastest}
<footer>Daily brief · made ${day(o.now.toISOString(), o.timeZone)} ${o.now.toLocaleDateString("en-GB", { year: "numeric", timeZone: o.timeZone })}${o.quotes ? "" : " · quotes left out"}</footer>
</main></body></html>
`;
}

/** File name for the download: "daily-brief-review-2026-11.html". */
export function reviewFileName(r: Review): string {
  return `daily-brief-review-${r.period.key}.html`;
}
