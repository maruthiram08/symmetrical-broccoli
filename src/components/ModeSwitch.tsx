"use client";

import { useState, useTransition } from "react";
import { MODES, type Mode } from "@/lib/theme/mode";
import { setModeAction } from "@/app/mode-actions";

/** System / Light / Dark. Applies at once, then the server keeps it for every page. */
export function ModeSwitch({ initial }: { initial: Mode }) {
  const [mode, setMode] = useState<Mode>(initial);
  const [pending, start] = useTransition();
  function pick(m: Mode) {
    setMode(m);
    if (m === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", m);
    start(async () => { await setModeAction(m); });
  }
  return (
    <div className="db-field">
      <span className="db-field__label" id="mode-label">Mode</span>
      <div className="th-seg" role="radiogroup" aria-labelledby="mode-label" aria-busy={pending}>
        {MODES.map((m) => (
          <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} className="th-seg__one" onClick={() => pick(m.id)}>{m.label}</button>
        ))}
      </div>
      <p className="db-field__hint">System follows your Mac&apos;s light or dark setting.</p>
    </div>
  );
}
