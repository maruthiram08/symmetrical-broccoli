"use client";

import { useEffect, useState, type MouseEvent, type ReactNode } from "react";

/**
 * The sidebar. On wide screens it is always open; on narrow ones it is a top bar with a Menu
 * button that opens the links below it. Following a link or searching closes it again.
 */
export function SideNav({ brand, children, foot }: { brand: ReactNode; children: ReactNode; foot?: ReactNode }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    // Over the page (the icon rail on mid-size windows): a click outside closes it.
    const onDown = (e: PointerEvent) => { if (!(e.target as HTMLElement | null)?.closest(".db-side")) setOpen(false); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("pointerdown", onDown); };
  }, [open]);

  const onClick = (e: MouseEvent) => { if ((e.target as HTMLElement).closest("a")) setOpen(false); };

  return (
    <nav className="db-side" aria-label="Days" data-open={open ? "" : undefined}>
      <div className="db-side__brand">
        {brand}
        <button className="db-side__menu" type="button" aria-expanded={open} aria-controls="db-side-body" onClick={() => setOpen((o) => !o)}>
          {open ? "Close" : "Menu"}
        </button>
      </div>
      <div className="db-side__body" id="db-side-body" onClick={onClick} onSubmit={() => setOpen(false)}>
        {children}
      </div>
      {foot}
    </nav>
  );
}
