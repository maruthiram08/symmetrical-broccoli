"use client";

// A drafted nudge on an overdue "Waiting on" item: Copy, or open the full "Start this" panel.
// Nothing is sent from here, except "Send on Slack…" after you confirm the person and text in its dialog.
import { useState } from "react";
import { markStartedAction } from "@/app/handoff-actions";
import { StartThisButton } from "./StartThis";
import { SlackNudge } from "./channels/SlackNudge";

async function copy(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

export function NudgeCard({ itemId, person, text, slack = false }: { itemId: string; person: string | null; text: string; slack?: boolean }) {
  const [flash, setFlash] = useState<string | null>(null);
  return (
    <div className="db-nudge" role="group" aria-label={`Nudge${person ? ` for ${person}` : ""}`}>
      <p className="db-nudge__label">Nudge{person ? ` ${person.split(/\s+/)[0]}` : ""}? A draft, in your words. Nothing is sent{slack ? " unless you send it" : ""}.</p>
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
        {slack ? <SlackNudge itemId={itemId} onSent={(m) => { setFlash(m); setTimeout(() => setFlash(null), 4000); }} /> : null}
        {flash ? <span className="db-nudge__flash" aria-live="polite">{flash}</span> : null}
      </div>
    </div>
  );
}
