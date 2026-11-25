"use client";

// A drafted nudge on an overdue "Waiting on" item: Copy, or open the full "Start this" panel.
// Nothing is sent from here.
import { useState } from "react";
import { markStartedAction } from "@/app/handoff-actions";
import { StartThisButton } from "./StartThis";

async function copy(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

export function NudgeCard({ itemId, person, text }: { itemId: string; person: string | null; text: string }) {
  const [flash, setFlash] = useState<string | null>(null);
  return (
    <div className="db-nudge" role="group" aria-label={`Nudge${person ? ` for ${person}` : ""}`}>
      <p className="db-nudge__label">Nudge{person ? ` ${person.split(/\s+/)[0]}` : ""}? A draft, in your words. Nothing is sent.</p>
      <p className="db-nudge__text">{text}</p>
      <div className="db-nudge__acts">
        <button
          type="button"
          className="db-act db-act--nudge"
          onClick={async () => {
            const ok = await copy(text);
            setFlash(ok ? "Copied" : "Couldn't copy. Select the text instead.");
            if (ok) void markStartedAction(itemId, "slack", "copy");
            setTimeout(() => setFlash(null), 2000);
          }}
        >
          Copy
        </button>
        <StartThisButton itemId={itemId} />
        {flash ? <span className="db-nudge__flash" aria-live="polite">{flash}</span> : null}
      </div>
    </div>
  );
}
