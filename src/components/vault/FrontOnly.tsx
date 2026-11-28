"use client";

import { useEffect, useState, type ReactNode } from "react";
import { FRONT_EVENT } from "@/lib/vault/layout";

/** Shows its children only while `path` is the note in front of the notes workbench. */
export function FrontOnly({ path, children }: { path: string; children: ReactNode }) {
  const [front, setFront] = useState(true);
  useEffect(() => {
    const on = (e: Event) => setFront((e as CustomEvent<string | null>).detail === path);
    window.addEventListener(FRONT_EVENT, on);
    return () => window.removeEventListener(FRONT_EVENT, on);
  }, [path]);
  return front ? <div className="db-vault__after">{children}</div> : null;
}
