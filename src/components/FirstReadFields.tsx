"use client";

import { useEffect, useRef, useState } from "react";
import { estimateMeetingsSince, type EstimateResult } from "@/app/actions";

const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;

/**
 * Step 3 of /welcome: the "read meetings since" date, the shared-meetings switch, and a live count
 * of what would be read (one search_meetings call per change, nothing read yet).
 */
export function FirstReadFields({ defaultDate, max }: { defaultDate: string; max: string }) {
  const [date, setDate] = useState(defaultDate);
  const [shared, setShared] = useState(false);
  const [est, setEst] = useState<EstimateResult | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const n = ++seq.current;
    setEst(null);
    if (!date) return;
    const t = setTimeout(() => {
      estimateMeetingsSince(date, shared)
        .then((r) => { if (n === seq.current) setEst(r); })
        .catch(() => { if (n === seq.current) setEst({ ok: false, error: "Couldn't count your meetings." }); });
    }, 250);
    return () => clearTimeout(t);
  }, [date, shared]);

  return (
    <>
      <div className="db-field">
        <label className="db-field__label" htmlFor="since">Read meetings since</label>
        <input className="db-input db-mono" id="since" name="since" type="date" max={max} value={date} onChange={(e) => setDate(e.target.value)} required />
      </div>
      <label className="db-check">
        <input className="db-switch" type="checkbox" role="switch" name="includeShared" checked={shared} onChange={(e) => setShared(e.target.checked)} />
        <span>
          <span className="db-check__label">Include meetings others shared with me</span>
          <span className="db-field__hint">Off by default. You can change it later in Settings.</span>
        </span>
      </label>
      <div className="db-estimate" role="status" aria-live="polite">
        {!date ? (
          <span className="db-estimate__muted">Pick a date.</span>
        ) : est === null ? (
          <span className="db-estimate__muted">Counting your meetings in Wispr Flow…</span>
        ) : !est.ok ? (
          <span className="db-note--error">{est.error}</span>
        ) : est.toRead === 0 ? (
          <span className="db-estimate__muted">No meetings to read in that range yet. New ones come in as they happen.</span>
        ) : (
          <>
            <span>
              <span className="db-estimate__n db-mono">{est.toRead}</span> {est.toRead === 1 ? "meeting" : "meetings"} to read
              {est.shared ? <span className="db-estimate__muted">, {est.shared} shared</span> : null}
            </span>
            <span className="db-estimate__muted">·</span>
            <span>about <span className="db-estimate__n db-mono">{inr(est.costInr)}</span></span>
            <span className="db-estimate__muted">at ~₹3.5 a meeting</span>
          </>
        )}
      </div>
    </>
  );
}
