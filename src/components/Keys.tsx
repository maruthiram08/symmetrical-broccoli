"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { OPEN_PALETTE } from "./CommandPalette";

const GO: Record<string, string> = { t: "/", o: "/open", p: "/people" };

function typing(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

/** "g t" Today, "g o" All open, "g p" People, "/" focuses search (or opens the palette when the field is hidden). Ignored while typing or in a dialog. */
export function Keys() {
  const router = useRouter();
  useEffect(() => {
    let pending = 0;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && (e.target as HTMLElement | null)?.id === "db-search") { (e.target as HTMLElement).blur(); return; }
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      const k = e.key.toLowerCase();
      if (pending && Date.now() - pending < 1200 && GO[k]) {
        e.preventDefault();
        pending = 0;
        router.push(GO[k]);
        return;
      }
      pending = 0;
      if (k === "g" && !e.shiftKey) { pending = Date.now(); return; }
      if (e.key === "/") {
        e.preventDefault();
        const field = document.getElementById("db-search") as HTMLInputElement | null;
        if (field && field.offsetParent) { field.focus(); field.select(); }
        else window.dispatchEvent(new Event(OPEN_PALETTE));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);
  return null;
}
