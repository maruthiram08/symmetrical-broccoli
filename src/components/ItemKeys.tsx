"use client";

// Item shortcuts on any list: j/k move, s star, z snooze, d done, w wrong (delete for your own),
// e edit (your own), F follow up (opens Start this). Ignored while typing or in a dialog.
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

const SELECTED = "db-item--selected";

function typing(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

const rows = () => [...document.querySelectorAll<HTMLElement>(".db-main [data-item-id]")];

export function ItemKeys() {
  const sel = useRef<{ id: string | null; index: number }>({ id: null, index: -1 });
  const path = usePathname();
  // A new page starts with nothing selected.
  useEffect(() => { sel.current = { id: null, index: -1 }; }, [path]);

  useEffect(() => {
    const paint = () => {
      const list = rows();
      let el = sel.current.id ? list.find((r) => r.dataset.itemId === sel.current.id) : undefined;
      // The selected item went away (done, snoozed): keep the place in the list.
      if (!el && sel.current.index >= 0 && list.length) {
        el = list[Math.min(sel.current.index, list.length - 1)];
        sel.current = { id: el.dataset.itemId ?? null, index: list.indexOf(el) };
      }
      for (const r of document.querySelectorAll(`.${SELECTED}`)) if (r !== el) r.classList.remove(SELECTED);
      el?.classList.add(SELECTED);
      return el;
    };
    const select = (el: HTMLElement | undefined) => {
      if (!el) return;
      sel.current = { id: el.dataset.itemId ?? null, index: rows().indexOf(el) };
      paint();
      el.scrollIntoView({ block: "nearest" });
    };
    const click = (el: HTMLElement | undefined, act: string) => {
      const b = el?.querySelector<HTMLButtonElement>(`[data-key-act="${act}"]`);
      if (b && !b.disabled) { b.click(); return true; }
      return false;
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      const list = rows();
      if (!list.length) return;
      const current = paint();
      const k = e.key;
      if (k === "j" || k === "k") {
        e.preventDefault();
        const at = current ? list.indexOf(current) : -1;
        const next = k === "j" ? Math.min(list.length - 1, at + 1) : at < 0 ? 0 : Math.max(0, at - 1);
        select(list[next]);
        return;
      }
      if (!current) return;
      if (k === "Escape") { sel.current = { id: null, index: -1 }; current.classList.remove(SELECTED); return; }
      const run = (act: string) => { if (click(current, act)) e.preventDefault(); };
      if (k === "s") run("star");
      else if (k === "z") run("snooze");
      else if (k === "d") run("done");
      else if (k === "w") {
        if (current.querySelector('[data-key-act="wrong"]')) run("wrong");
        else run("edit"); // your own item: edit holds Delete
      } else if (k === "e") run("edit");
      else if (k === "F") {
        const b = current.querySelector<HTMLButtonElement>(".db-act--start");
        if (b) {
          e.preventDefault();
          if (b.getAttribute("aria-expanded") !== "true") b.click();
          requestAnimationFrame(() => current.querySelector<HTMLElement>(".db-handoff__tab[aria-selected=\"true\"], .db-handoff__panel button")?.focus());
        }
      }
    };

    // Lists re-render after each action: keep the selection painted.
    const mo = new MutationObserver(() => { if (sel.current.id) paint(); });
    mo.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); mo.disconnect(); };
  }, []);
  return null;
}
