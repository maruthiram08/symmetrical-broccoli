// Options: the app address (localhost only) and the local API token, in storage.local.
(function () {
  "use strict";
  var ext = typeof browser !== "undefined" ? browser : chrome;
  var api = window.__dailyBriefApi;
  var $ = function (id) { return document.getElementById(id); };
  $("origin").textContent = location.origin;
  ext.storage.local.get({ base: api.DEFAULT_BASE, token: "" }).then(function (s) {
    $("base").value = s.base;
    $("token").value = s.token;
  });
  $("save").addEventListener("click", function () {
    var base = api.cleanBase($("base").value);
    var token = $("token").value.trim();
    var st = $("status");
    if (!base) { st.textContent = "Use an address on this computer, like http://localhost:4242."; st.className = "err"; return; }
    if (token && !/^[A-Za-z0-9+/=_.-]{8,512}$/.test(token)) { st.textContent = "That doesn't look like a token."; st.className = "err"; return; }
    ext.storage.local.set({ base: base, token: token }).then(function () { st.textContent = "Saved."; st.className = "ok"; });
  });
})();
