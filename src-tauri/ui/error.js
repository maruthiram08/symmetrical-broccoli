// Shows the title and detail the app passes in the URL (?title=...&detail=...).
const q = new URLSearchParams(location.search);
if (q.get("title")) document.getElementById("title").textContent = q.get("title");
if (q.get("detail")) document.getElementById("detail").textContent = q.get("detail");
