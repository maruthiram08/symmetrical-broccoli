// A note or page as one self-contained HTML file: inline styles, no scripts, no remote fonts or
// images, no links back to this Mac. The same file prints to PDF (print styles included).
import { docBlocks, type Block, type ExportDoc, type Inline } from "./doc";

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function inlineHtml(c: Inline[]): string {
  return c.map((x) => {
    switch (x.t) {
      case "text": return esc(x.v);
      case "b": return `<strong>${inlineHtml(x.c)}</strong>`;
      case "i": return `<em>${inlineHtml(x.c)}</em>`;
      case "s": return `<s>${inlineHtml(x.c)}</s>`;
      case "code": return `<code>${esc(x.v)}</code>`;
      case "link": return `<a href="${esc(x.href)}" rel="noopener noreferrer">${inlineHtml(x.c)}</a>`;
      case "wiki": return `<span class="wl">${esc(x.label)}</span>`;
      case "br": return "<br>";
    }
  }).join("");
}

export function blocksHtml(blocks: Block[]): string {
  return blocks.map(blockHtml).join("\n");
}

function blockHtml(b: Block): string {
  switch (b.t) {
    case "h": return `<h${b.level}>${inlineHtml(b.c)}</h${b.level}>`;
    case "p": return `<p>${inlineHtml(b.c)}</p>`;
    case "hr": return "<hr>";
    case "code": return `<pre><code>${esc(b.v)}</code></pre>`;
    case "quote": return `<blockquote>${blocksHtml(b.blocks)}</blockquote>`;
    case "callout": return `<aside class="callout callout--${esc(b.kind)}"><p class="callout__t">${inlineHtml(b.title) || esc(b.kind[0].toUpperCase() + b.kind.slice(1))}</p>${blocksHtml(b.blocks)}</aside>`;
    case "table": {
      const head = b.head.length ? `<thead><tr>${b.head.map((c) => `<th>${inlineHtml(c)}</th>`).join("")}</tr></thead>` : "";
      return `<table>${head}<tbody>${b.rows.map((r) => `<tr>${r.map((c) => `<td>${inlineHtml(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
    }
    case "list": {
      const tag = b.ordered ? "ol" : "ul";
      const tasks = b.items.some((i) => i.checked !== null);
      const start = b.ordered && b.start !== 1 ? ` start="${b.start}"` : "";
      const lis = b.items.map((i) => {
        const box = i.checked === null ? "" : `<span class="box${i.checked ? " box--on" : ""}" aria-label="${i.checked ? "done" : "to do"}">${i.checked ? "✓" : ""}</span>`;
        // A single paragraph sits on the bullet's line.
        const inner = i.blocks.length && i.blocks[0].t === "p" ? `${inlineHtml(i.blocks[0].c)}${blocksHtml(i.blocks.slice(1))}` : blocksHtml(i.blocks);
        return `<li${i.checked ? ' class="done"' : ""}>${box}${inner}</li>`;
      }).join("");
      return `<${tag}${start}${tasks ? ' class="tasks"' : ""}>${lis}</${tag}>`;
    }
  }
}

/** The design's tokens and type, light and dark, plus print rules (A4, ink on white, no page-breaking inside blocks). */
export const EXPORT_CSS = `
:root{--bg:#fff;--ink:#0a0a0a;--muted:#525252;--faint:#666;--border:#ececec;--surface:#fafafa;--hl:#d6ff3d;--on-hl:#0a0a0a;--late:#c4320a;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0b0b0c;--ink:#f4f4f5;--muted:#a1a1aa;--faint:#8b8b94;--border:#1f1f23;--surface:#111113;--late:#ff6b4a;color-scheme:dark}}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:var(--bg);color:var(--ink);font:15px/1.55 "Instrument Sans",-apple-system,"Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased;overflow-wrap:break-word}
main{max-width:680px;margin:0 auto;padding:48px 16px 64px}
header{margin-bottom:28px}
h1{font-size:32px;line-height:38px;letter-spacing:-.03em;margin:0 0 4px;font-weight:600;text-wrap:balance}
.sub{color:var(--muted);margin:0;font-size:13px}
article h1{font-size:26px;line-height:32px;margin:32px 0 8px}
h2{font-size:20px;line-height:26px;letter-spacing:-.02em;margin:32px 0 8px;font-weight:600}
h3{font-size:16px;line-height:22px;margin:24px 0 6px;font-weight:600}
h4,h5,h6{font-size:14px;margin:20px 0 4px;font-weight:600;color:var(--muted)}
p{margin:0 0 10px}
a{color:inherit;text-underline-offset:2px}
code,pre{font-family:"Geist Mono",ui-monospace,"SF Mono",Menlo,monospace;font-size:13px}
code{background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:0 4px}
pre{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px 14px;overflow-x:auto;white-space:pre-wrap}
pre code{border:0;padding:0;background:none}
blockquote{margin:0 0 12px;padding:2px 0 2px 14px;border-left:2px solid var(--border);color:var(--muted)}
.callout{margin:0 0 12px;padding:10px 14px;border:1px solid var(--border);border-radius:8px;background:var(--surface)}
.callout__t{font-weight:600;margin-bottom:4px}
.callout--decision .callout__t::before{content:"";display:inline-block;width:8px;height:8px;margin-right:8px;background:var(--ink);transform:rotate(45deg);border-radius:1px;vertical-align:1px}
hr{border:0;border-top:1px solid var(--border);margin:24px 0}
ul,ol{margin:0 0 12px;padding-left:22px}
li{margin:2px 0}
li>p{margin:0}
ul.tasks{list-style:none;padding-left:4px}
.box{display:inline-grid;place-items:center;width:14px;height:14px;margin-right:8px;border:1.5px solid var(--muted);border-radius:4px;font-size:10px;line-height:1;vertical-align:-2px}
.box--on{background:var(--ink);border-color:var(--ink);color:var(--bg)}
li.done{color:var(--faint)}
table{border-collapse:collapse;margin:0 0 14px;width:100%;font-size:14px}
th,td{border:1px solid var(--border);padding:6px 10px;text-align:left;vertical-align:top}
th{background:var(--surface);font-weight:600}
.wl{border-bottom:1px solid var(--faint)}
footer{margin-top:48px;color:var(--faint);font-size:12px}
@page{size:A4;margin:18mm 16mm}
@media print{
  :root{--bg:#fff;--ink:#0a0a0a;--muted:#444;--faint:#666;--border:#dcdcdc;--surface:#f6f6f6;color-scheme:light}
  body{font-size:11pt;line-height:1.5}
  main{max-width:none;padding:0}
  pre,blockquote,.callout,table,li{break-inside:avoid}
  h1,h2,h3{break-after:avoid}
  a{text-decoration:none}
  a[href^="http"]::after{content:" (" attr(href) ")";color:var(--faint);font-size:9pt}
  footer{margin-top:24px}
}
`;

export interface HtmlExportOptions {
  /** When the file was made, for the footer. */
  now?: Date;
  /** Extra markup for <head>: the print page adds its print script here. */
  head?: string;
}

/** A whole page as a standalone HTML document. */
export function renderExportHtml(d: ExportDoc, o: HtmlExportOptions = {}): string {
  const made = (o.now ?? new Date()).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(d.title)}</title>
<style>${EXPORT_CSS}</style>${o.head ?? ""}
</head>
<body>
<main>
<header><h1>${esc(d.title)}</h1>${d.subtitle ? `<p class="sub">${esc(d.subtitle)}</p>` : ""}</header>
<article>
${blocksHtml(docBlocks(d))}
</article>
<footer>Exported from Daily brief, ${esc(made)}.</footer>
</main>
</body>
</html>
`;
}
