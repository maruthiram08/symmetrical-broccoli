"use client";

// Settings shows one section at a time. A link or redirect to /setup#some-anchor opens the
// section that holds that anchor.
import { useEffect } from "react";

export function SettingsHash() {
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (!id) return;
    const el = document.getElementById(id) ?? document.querySelector(`[id^="${CSS.escape(id)}"]`);
    const sec = el?.closest<HTMLElement>("[data-sec]");
    if (!sec || !sec.hidden) { el?.scrollIntoView({ block: "start" }); return; }
    const u = new URL(window.location.href);
    u.searchParams.set("section", sec.dataset.sec ?? "you");
    window.location.replace(u.toString());
  }, []);
  return null;
}
