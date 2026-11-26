"use client";

// "Send on Slack…" on a nudge draft. Opens a dialog that shows who gets it and the exact text, and
// sends only when you press Send in that dialog. Every send asks again; nothing is ever automatic.
import { useRef, useState } from "react";
import { findNudgeRecipient, prepareNudge, sendNudge, type NudgeCandidate, type NudgePrep } from "@/app/channel-actions";

type Ready = Extract<NudgePrep, { ok: true }>;

export function SlackNudge({ itemId, onSent }: { itemId: string; onSent?: (msg: string) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [prep, setPrep] = useState<Ready | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");

  const load = (r: NudgePrep) => {
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setPrep(r);
    setError(null);
    setPick(r.candidates.length === 1 ? r.candidates[0].id : null);
  };

  const open = async () => {
    setPrep(null);
    setPick(null);
    setError(null);
    setEmail("");
    ref.current?.showModal();
    setBusy(true);
    load(await prepareNudge(itemId));
    setBusy(false);
  };

  const close = () => ref.current?.close();
  const chosen: NudgeCandidate | undefined = prep?.candidates.find((c) => c.id === pick);
  const first = chosen?.name.split(/\s+/)[0];

  const send = async () => {
    if (!chosen) return;
    setBusy(true);
    const r = await sendNudge({ itemId, memberId: chosen.id, exp: chosen.exp, sig: chosen.sig, confirmed: true });
    setBusy(false);
    if (!r.ok) {
      setError(r.message);
      return;
    }
    close();
    onSent?.(`Sent to ${chosen.name} on Slack`);
  };

  return (
    <>
      <button type="button" className="db-act db-act--nudge" onClick={open}>Send on Slack…</button>
      <dialog ref={ref} className="ch-dialog" aria-labelledby={`nudge-${itemId}-title`} onClose={() => setBusy(false)}>
        <div className="ch-dialog__inner">
          <h2 className="ch-dialog__title" id={`nudge-${itemId}-title`}>Send this nudge on Slack?</h2>
          {busy && !prep ? <p className="ch-dialog__note">Looking up people in your Slack…</p> : null}
          {prep ? (
            <>
              <div>
                <p className="ch-dialog__label">To</p>
                {prep.candidates.length ? (
                  <fieldset className="ch-dialog__to" aria-label="Recipient">
                    {prep.candidates.map((c) => (
                      <label key={c.id} className="ch-dialog__member">
                        <input type="radio" name={`to-${itemId}`} value={c.id} checked={pick === c.id} onChange={() => setPick(c.id)} />
                        <span>{c.name}</span>
                        {c.detail ? <small>{c.detail}</small> : null}
                      </label>
                    ))}
                  </fieldset>
                ) : (
                  <p className="ch-dialog__note">No one in your Slack is called {prep.person ?? "that"}. Find them by email:</p>
                )}
                <form
                  className="ch-dialog__find"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    setBusy(true);
                    load(await findNudgeRecipient(itemId, email));
                    setBusy(false);
                  }}
                  hidden={prep.candidates.length > 0}
                >
                  <input className="db-input" type="email" placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Their Slack email" />
                  <button className="db-btn" type="submit" disabled={busy || !email}>Find</button>
                </form>
              </div>
              <div>
                <p className="ch-dialog__label">Text</p>
                <p className="ch-dialog__text">{prep.text}</p>
              </div>
              <p className="ch-dialog__note">{prep.asUser ? "Sent as you, as a direct message." : "Sent by your Daily brief Slack app, as a direct message."} It goes out the moment you press Send.</p>
            </>
          ) : null}
          {error ? <p className="ch-dialog__err" role="alert">{error}</p> : null}
          <div className="ch-dialog__acts">
            <button type="button" className="db-btn db-btn--ghost" onClick={close}>Cancel</button>
            <button type="button" className="db-btn db-btn--primary" onClick={send} disabled={!chosen || busy}>
              {chosen ? `Send to ${first}` : "Send"}
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}
