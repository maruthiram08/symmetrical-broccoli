"use client";

import { useState, type ReactNode } from "react";

/**
 * An item's action buttons. Wide screens show them all (on hover/focus, see globals.css). On phones
 * only the main one (marked .db-act-keep) shows, with a "…" button that reveals the rest on the row.
 */
export function ItemActs({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="db-item__acts" data-open={open ? "" : undefined}>
      {children}
      <button
        className="db-act db-act--more"
        type="button"
        aria-expanded={open}
        aria-label={open ? "Fewer actions" : "More actions"}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? "×" : "…"}
      </button>
    </span>
  );
}
