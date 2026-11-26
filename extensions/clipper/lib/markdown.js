// Daily brief web clipper: turns the page selection, or the page's readable article, into Markdown.
// Runs inside the page (injected by popup.js with chrome.scripting). No dependencies, no network.
// Works on anything shaped like a DOM node (nodeType, nodeName, childNodes, textContent,
// getAttribute), so the tests can pass plain objects.
(function (root) {
  "use strict";

  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1, CANVAS: 1, IFRAME: 1, FORM: 1, BUTTON: 1, INPUT: 1, SELECT: 1, TEXTAREA: 1, NAV: 1, ASIDE: 1, FOOTER: 1 };
  var BLOCK = { P: 1, DIV: 1, SECTION: 1, ARTICLE: 1, MAIN: 1, HEADER: 1, FIGURE: 1, FIGCAPTION: 1, BLOCKQUOTE: 1, UL: 1, OL: 1, LI: 1, PRE: 1, TABLE: 1, TR: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, HR: 1, DL: 1, DT: 1, DD: 1 };

  function attr(n, name) {
    return n && typeof n.getAttribute === "function" ? n.getAttribute(name) : null;
  }

  /** Absolute http(s) links only; anything else (javascript:, data:) becomes plain text. */
  function safeHref(href, base) {
    if (!href) return null;
    try {
      var u = new URL(href, base || undefined);
      return u.protocol === "http:" || u.protocol === "https:" || u.protocol === "mailto:" ? u.toString() : null;
    } catch (e) {
      return null;
    }
  }

  function escapeText(s) {
    return s.replace(/([\\`*_[\]])/g, "\\$1");
  }

  function inlineOf(n, ctx) {
    var out = "";
    var kids = n.childNodes || [];
    for (var i = 0; i < kids.length; i++) out += convert(kids[i], ctx);
    return out;
  }

  function convert(n, ctx) {
    if (!n) return "";
    if (n.nodeType === 3) {
      var t = String(n.textContent || "");
      if (ctx.pre) return t;
      return escapeText(t.replace(/\s+/g, " "));
    }
    if (n.nodeType !== 1 && n.nodeType !== 11 && n.nodeType !== 9) return "";
    var tag = String(n.nodeName || "").toUpperCase();
    if (SKIP[tag]) return "";
    if (attr(n, "aria-hidden") === "true" || attr(n, "hidden") !== null && attr(n, "hidden") !== undefined) return "";
    var inner;
    switch (tag) {
      case "BR": return ctx.pre ? "\n" : "  \n";
      case "HR": return "\n\n---\n\n";
      case "H1": case "H2": case "H3": case "H4": case "H5": case "H6":
        inner = inlineOf(n, ctx).trim();
        return inner ? "\n\n" + "######".slice(0, Number(tag[1])) + " " + inner.replace(/\n+/g, " ") + "\n\n" : "";
      case "P": case "DIV": case "SECTION": case "ARTICLE": case "MAIN": case "HEADER": case "FIGURE": case "FIGCAPTION": case "DL": case "DT": case "DD":
        inner = inlineOf(n, ctx).trim();
        return inner ? "\n\n" + inner + "\n\n" : "";
      case "STRONG": case "B":
        inner = inlineOf(n, ctx).trim();
        return inner ? "**" + inner + "**" : "";
      case "EM": case "I":
        inner = inlineOf(n, ctx).trim();
        return inner ? "*" + inner + "*" : "";
      case "S": case "DEL": case "STRIKE":
        inner = inlineOf(n, ctx).trim();
        return inner ? "~~" + inner + "~~" : "";
      case "CODE":
        if (ctx.pre) return String(n.textContent || "");
        inner = String(n.textContent || "").replace(/\s+/g, " ");
        return inner ? "`" + inner.replace(/`/g, "ˋ") + "`" : "";
      case "PRE": {
        var code = String(n.textContent || "").replace(/\n+$/, "");
        return code ? "\n\n```\n" + code.replace(/```/g, "``​`") + "\n```\n\n" : "";
      }
      case "A": {
        inner = inlineOf(n, ctx).trim();
        var href = safeHref(attr(n, "href"), ctx.base);
        if (!inner) return "";
        return href ? "[" + inner.replace(/\n+/g, " ") + "](" + href.replace(/\)/g, "%29").replace(/ /g, "%20") + ")" : inner;
      }
      case "IMG": {
        var src = safeHref(attr(n, "src"), ctx.base);
        var alt = String(attr(n, "alt") || "").replace(/[[\]\n]/g, " ").trim();
        return src && !/^data:/.test(src) ? "![" + alt + "](" + src.replace(/\)/g, "%29") + ")" : "";
      }
      case "BLOCKQUOTE":
        inner = clean(inlineOf(n, ctx));
        return inner ? "\n\n" + inner.split("\n").map(function (l) { return l ? "> " + l : ">"; }).join("\n") + "\n\n" : "";
      case "UL": case "OL": {
        var lines = [];
        var k = 0;
        var depth = ctx.depth || 0;
        var kids = n.childNodes || [];
        for (var i = 0; i < kids.length; i++) {
          var c = kids[i];
          if (String(c.nodeName || "").toUpperCase() !== "LI") continue;
          k++;
          var body = clean(inlineOf(c, { base: ctx.base, depth: depth + 1 }));
          if (!body) continue;
          var mark = tag === "OL" ? k + ". " : "- ";
          var pad = "  ".repeat(depth);
          lines.push(pad + mark + body.split("\n").join("\n" + pad + "  "));
        }
        return lines.length ? "\n\n" + lines.join("\n") + "\n\n" : "";
      }
      case "LI":
        return inlineOf(n, ctx);
      case "TABLE": {
        var rows = [];
        collectRows(n, rows);
        if (!rows.length) return "";
        var cells = rows.map(function (r) { return r.map(function (c) { return clean(inlineOf(c, ctx)).replace(/\n+/g, " ").replace(/\|/g, "\\|"); }); });
        var w = Math.max.apply(null, cells.map(function (r) { return r.length; }));
        var line = function (r) { var x = r.slice(); while (x.length < w) x.push(""); return "| " + x.join(" | ") + " |"; };
        var sep = "|" + new Array(w + 1).join(" --- |");
        return "\n\n" + [line(cells[0]), sep].concat(cells.slice(1).map(line)).join("\n") + "\n\n";
      }
      default:
        inner = inlineOf(n, ctx);
        return BLOCK[tag] ? "\n\n" + inner + "\n\n" : inner;
    }
  }

  function collectRows(n, rows) {
    var kids = n.childNodes || [];
    for (var i = 0; i < kids.length; i++) {
      var c = kids[i];
      var tag = String(c.nodeName || "").toUpperCase();
      if (tag === "TR") {
        var r = [];
        var cs = c.childNodes || [];
        for (var j = 0; j < cs.length; j++) {
          var ct = String(cs[j].nodeName || "").toUpperCase();
          if (ct === "TD" || ct === "TH") r.push(cs[j]);
        }
        if (r.length) rows.push(r);
      } else if (tag === "THEAD" || tag === "TBODY" || tag === "TFOOT") collectRows(c, rows);
    }
  }

  /** Tidies blank lines and trailing spaces. */
  function clean(md) {
    return String(md)
      .replace(/[ \t]+\n/g, function (m) { return /  \n$/.test(m) ? "  \n" : "\n"; })
      .replace(/\n{3,}/g, "\n\n")
      .replace(/^\s+|\s+$/g, "");
  }

  function toMarkdown(node, base) {
    return clean(convert(node, { base: base || null, depth: 0 }));
  }

  /** Text length of a node, minus links (link-heavy blocks are navigation, not the article). */
  function textScore(n) {
    var text = String(n.textContent || "").replace(/\s+/g, " ").trim().length;
    var links = 0;
    var as = typeof n.querySelectorAll === "function" ? n.querySelectorAll("a") : [];
    for (var i = 0; i < as.length; i++) links += String(as[i].textContent || "").trim().length;
    var paras = typeof n.querySelectorAll === "function" ? n.querySelectorAll("p").length : 0;
    return text - links * 2 + paras * 40;
  }

  /** The page's main content: <article>, <main>, [role=main], else the densest block of text. */
  function readableRoot(doc) {
    var pick = doc.querySelector && (doc.querySelector("article") || doc.querySelector("main") || doc.querySelector("[role=main]"));
    if (pick && String(pick.textContent || "").trim().length > 200) return pick;
    var best = doc.body;
    var bestScore = 0;
    var blocks = doc.querySelectorAll ? doc.querySelectorAll("div, section, td") : [];
    for (var i = 0; i < blocks.length; i++) {
      var s = textScore(blocks[i]);
      if (s > bestScore) { bestScore = s; best = blocks[i]; }
    }
    return best || doc.body;
  }

  /** What the popup asks for: { title, url, markdown, kind }. */
  function grab(mode) {
    var doc = root.document;
    var url = String(root.location && root.location.href || "");
    var title = String(doc.title || "").trim();
    if (mode !== "article") {
      var sel = root.getSelection && root.getSelection();
      if (sel && sel.rangeCount && String(sel).trim()) {
        var frag = doc.createElement("div");
        for (var i = 0; i < sel.rangeCount; i++) frag.appendChild(sel.getRangeAt(i).cloneContents());
        return { title: title, url: url, markdown: toMarkdown(frag, url), kind: "selection" };
      }
      if (mode === "selection") return { title: title, url: url, markdown: "", kind: "selection" };
    }
    var main = readableRoot(doc);
    var h1 = main && main.querySelector ? main.querySelector("h1") : null;
    return { title: (h1 && String(h1.textContent || "").trim()) || title, url: url, markdown: toMarkdown(main, url), kind: "article" };
  }

  var api = { toMarkdown: toMarkdown, readableRoot: readableRoot, grab: grab, safeHref: safeHref };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.__dailyBriefClip = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
