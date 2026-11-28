// Cross-check with Wispr Flow: the rows of /crosscheck, the meeting page's "Wispr Flow also
// listed…" block, and the switch in Settings › AI. Server components with plain form actions.
import Link from "next/link";
import { SubmitOnChange } from "@/components/SubmitOnChange";
import { addFromCrossCheckAction, ignoreCrossCheckAction, saveCrosscheckSettingAction } from "@/app/crosscheck-actions";
import { openMissed, type CrossCheckRecord, type CrossEntry } from "@/lib/crosscheck/compare";
import { crosscheckEnabled } from "@/server/crosscheck/core";
import { isHosted } from "@/server/mode";

/** One item Wispr Flow listed and Daily brief has nothing for, with Add as You owe / Waiting on / Ignore. */
export function MissedRow({ meetingId, index, e }: { meetingId: string; index: number; e: CrossEntry }) {
  const suggested = e.kind ?? "owe";
  return (
    <li className="xc-row">
      <div className="xc-row__text">
        <span className="xc-row__wispr">{e.wispr.text}</span>
        <span className="xc-row__meta">
          {e.wispr.owner ? <>Wispr: {e.wispr.owner}</> : <>No owner in Wispr</>}
          {e.person && e.person !== e.wispr.owner ? <> · with {e.person}</> : null}
          {e.droppedReason ? <> · Daily brief left it out ({e.droppedReason})</> : null}
        </span>
      </div>
      <div className="xc-row__acts">
        {(["owe", "waiting"] as const).map((kind) => (
          <form key={kind} action={addFromCrossCheckAction}>
            <input type="hidden" name="meetingId" value={meetingId} />
            <input type="hidden" name="index" value={index} />
            <input type="hidden" name="kind" value={kind} />
            <button className={suggested === kind ? "db-act xc-act--suggested" : "db-act"}>{kind === "owe" ? "Add as You owe" : "Add as Waiting on"}</button>
          </form>
        ))}
        <form action={ignoreCrossCheckAction}>
          <input type="hidden" name="meetingId" value={meetingId} />
          <input type="hidden" name="index" value={index} />
          <button className="db-act xc-act--quiet">Ignore</button>
        </form>
      </div>
    </li>
  );
}

/** On a meeting's page, when Wispr Flow listed things Daily brief doesn't have. */
export function MeetingCrossCheck({ rec }: { rec: CrossCheckRecord | null }) {
  if (!rec || isHosted()) return null;
  const missed = openMissed(rec);
  if (!missed.length) return null;
  return (
    <section className="db-section xc-meeting" aria-labelledby="xc-meeting-h">
      <div className="db-section__head">
        <h2 className="db-section__title" id="xc-meeting-h">Wispr Flow also listed…</h2>
        <span className="db-section__count">{missed.length}</span>
      </div>
      <ul className="xc-list">
        {missed.map(({ e, i }) => <MissedRow key={i} meetingId={rec.meetingId} index={i} e={e} />)}
      </ul>
      <p className="xc-foot"><Link className="db-link" href="/crosscheck">All cross-checks</Link></p>
    </section>
  );
}

/** Settings › AI: the switch. Off by default. */
export function CrossCheckSettings() {
  if (isHosted()) return null;
  const on = crosscheckEnabled();
  return (
    <div id="ai-crosscheck" className="ai-block">
      <h3 className="ai-h3">Cross-check with Wispr Flow</h3>
      <form action={saveCrosscheckSettingAction} className="db-stack">
        <label className="db-check">
          <SubmitOnChange name="crosscheck" defaultChecked={on} />
          <span>
            <span className="db-check__label">Cross-check with Wispr Flow</span>
            <span className="db-field__hint">
              After each meeting is read, compare Wispr Flow&apos;s own action items (from its summary) with what Daily brief found,
              using the Extraction model. One small call per meeting with the summary and item texts only, never the transcript.
            </span>
          </span>
        </label>
      </form>
      <p className="db-note"><Link href="/crosscheck">See the cross-check</Link></p>
    </div>
  );
}
