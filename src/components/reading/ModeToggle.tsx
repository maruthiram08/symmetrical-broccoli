"use client";

import { useEffect, useState, useTransition } from "react";
import type { Mode } from "@/lib/theme/mode";
import { setModeAction } from "@/app/mode-actions";

/**
 * The sidebar's Light / Dark switch. It sets the same Mode cookie as Settings › Appearance; while
 * the Mode is System, the side your Mac is on shows as picked.
 */
export function ModeToggle({ initial }: { initial: Mode }) {
  const [mode, setMode] = useState<Mode>(initial);
  const [systemDark, setSystemDark] = useState(false);
  const [pending, start] = useTransition();
  useEffect(() => {
    const q = window.matchMedia("(prefers-color-scheme: dark)");
    setSystemDark(q.matches);
    const on = () => setSystemDark(q.matches);
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, []);
  const shown = mode === "system" ? (systemDark ? "dark" : "light") : mode;
  const pick = (m: "light" | "dark") => {
    setMode(m);
    document.documentElement.setAttribute("data-theme", m);
    start(async () => { await setModeAction(m); });
  };
  return (
    <div className="rp-mode" role="radiogroup" aria-label="Mode" aria-busy={pending}>
      {(["light", "dark"] as const).map((m) => (
        <button key={m} type="button" role="radio" aria-checked={shown === m} className={shown === m ? "rp-mode--on" : undefined} onClick={() => pick(m)}>
          {m === "light" ? "Light" : "Dark"}
        </button>
      ))}
    </div>
  );
}
