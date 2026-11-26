// Talks to the Daily brief local API (docs/API.md) on this computer. The token stays in the
// browser's extension storage (storage.local), never in sync storage, and only goes to localhost.
(function (root) {
  "use strict";
  var DEFAULT_BASE = "http://localhost:4242";

  /** Only http://localhost or http://127.0.0.1, any port: the API refuses everything else anyway. */
  function cleanBase(u) {
    try {
      var x = new URL(String(u || "").trim() || DEFAULT_BASE);
      if (x.protocol !== "http:" && x.protocol !== "https:") return null;
      if (x.hostname !== "localhost" && x.hostname !== "127.0.0.1") return null;
      return x.origin;
    } catch (e) {
      return null;
    }
  }

  /** Sends one clip. Resolves { ok, status, message, url }. Never throws. */
  function sendClip(settings, clip, doFetch) {
    var f = doFetch || root.fetch.bind(root);
    var base = cleanBase(settings.base);
    if (!base) return Promise.resolve({ ok: false, status: 0, message: "The app address must be on this computer (localhost)." });
    if (!settings.token) return Promise.resolve({ ok: false, status: 0, message: "Paste your token in the clipper's options first." });
    return f(base + "/api/v1/clips", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + settings.token },
      body: JSON.stringify(clip),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (res.ok) return { ok: true, status: res.status, message: clip.target === "new" ? "Saved as a new note." : "Added to your Inbox note.", url: body.url || null };
        var msg = res.status === 401 ? "The token was refused. Paste a fresh one from Settings › Local API."
          : res.status === 403 ? (body.error || "Refused. Add this extension's origin in Settings › Local API.")
          : res.status === 429 ? "Too many clips in a minute. Wait a moment."
          : body.error || "Daily brief answered " + res.status + ".";
        return { ok: false, status: res.status, message: msg };
      });
    }, function () {
      return { ok: false, status: 0, message: "Couldn't reach Daily brief at " + base + ". Is it running?" };
    });
  }

  var api = { sendClip: sendClip, cleanBase: cleanBase, DEFAULT_BASE: DEFAULT_BASE };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.__dailyBriefApi = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
