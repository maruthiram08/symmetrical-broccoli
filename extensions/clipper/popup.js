// The popup: grabs the selection or article from the current tab (lib/markdown.js, injected only
// when you press Clip, thanks to activeTab) and sends it to Daily brief's local API.
(function () {
  "use strict";
  var ext = typeof browser !== "undefined" ? browser : chrome;
  var $ = function (id) { return document.getElementById(id); };
  var status = $("status");
  var show = function (msg, ok) { status.textContent = msg; status.className = ok ? "ok" : ok === false ? "err" : ""; };
  var pick = function (name) { var x = document.querySelector("input[name=" + name + "]:checked"); return x ? x.value : null; };

  ext.storage.local.get({ base: window.__dailyBriefApi.DEFAULT_BASE, token: "", target: "inbox" }).then(function (s) {
    var t = document.querySelector("input[name=target][value=" + (s.target === "new" ? "new" : "inbox") + "]");
    if (t) t.checked = true;
    if (!s.token) show("Paste your Daily brief token in Options first.", false);
  });
  ext.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
    if (tabs[0] && tabs[0].title) $("title").placeholder = tabs[0].title.slice(0, 200);
  });
  $("options").addEventListener("click", function (e) { e.preventDefault(); ext.runtime.openOptionsPage(); });

  $("clip").addEventListener("click", function () {
    var btn = $("clip");
    btn.disabled = true;
    show("Clipping…");
    var mode = pick("mode");
    var target = pick("target");
    ext.storage.local.set({ target: target });
    ext.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
      var tab = tabs[0];
      if (!tab || !/^https?:/.test(tab.url || "")) throw new Error("This page can't be clipped.");
      return ext.scripting.executeScript({ target: { tabId: tab.id }, files: ["lib/markdown.js"] }).then(function () {
        return ext.scripting.executeScript({ target: { tabId: tab.id }, func: function (m) { return globalThis.__dailyBriefClip.grab(m); }, args: [mode] });
      });
    }).then(function (results) {
      var r = results && results[0] && results[0].result;
      if (!r || !r.markdown) throw new Error("Nothing to clip here. Select some text, or try The readable article.");
      return ext.storage.local.get({ base: window.__dailyBriefApi.DEFAULT_BASE, token: "" }).then(function (s) {
        return window.__dailyBriefApi.sendClip(s, { markdown: r.markdown.slice(0, 200000), title: $("title").value.trim() || r.title || undefined, url: r.url || undefined, target: target, kind: r.kind });
      });
    }).then(function (res) {
      show(res.message, res.ok);
    }, function (e) {
      show(e && e.message ? e.message : "Couldn't clip this page.", false);
    }).then(function () { btn.disabled = false; });
  });
})();
