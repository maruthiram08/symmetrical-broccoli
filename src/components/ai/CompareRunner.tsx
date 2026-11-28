"use client";

// Compare: pick a meeting and 2-3 models, see the estimate, confirm, then the results side by side.
// It never runs on its own: running needs the estimate's confirmation id and a ticked box.
import { useState } from "react";
import type { CompareEstimate, CompareResult } from "@/server/compare";
import type { ProviderId } from "@/lib/ai/providers";

type Prov = { id: ProviderId; label: string; suggestions: string[] };
type Row = { provider: ProviderId; model: string };
const KIND = { owe: "You owe", waiting: "Waiting on", decision: "Decision" } as const;

export function CompareRunner({ meetings, providers, initial, estimate, run }: {
  meetings: Array<{ id: string; label: string }>;
  providers: Prov[];
  initial: Row[];
  estimate: (meetingId: string, pairs: Row[]) => Promise<{ ok: true; estimate: CompareEstimate } | { ok: false; error: string }>;
  run: (confirmId: string, confirmed: boolean) => Promise<{ ok: true; result: CompareResult } | { ok: false; error: string }>;
}) {
  const [meetingId, setMeetingId] = useState(meetings[0]?.id ?? "");
  const [rows, setRows] = useState<Row[]>(initial);
  const [est, setEst] = useState<CompareEstimate | null>(null);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState<"estimate" | "run" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CompareResult | null>(null);
  const byId = new Map(providers.map((p) => [p.id, p]));
  const changed = () => { setEst(null); setAgree(false); };
  const setRow = (k: number, patch: Partial<Row>) => { setRows((xs) => xs.map((x, j) => (j === k ? { ...x, ...patch } : x))); changed(); };

  const doEstimate = async () => {
    setBusy("estimate"); setError(null); setResult(null);
    const r = await estimate(meetingId, rows).catch(() => ({ ok: false as const, error: "Couldn't reach the app." }));
    setBusy(null);
    if (r.ok) { setEst(r.estimate); setAgree(false); } else setError(r.error);
  };
  const doRun = async () => {
    if (!est || !agree) return;
    setBusy("run"); setError(null);
    const r = await run(est.confirmId, true).catch(() => ({ ok: false as const, error: "Couldn't reach the app." }));
    setBusy(null);
    setEst(null); setAgree(false); // a confirmation is used once
    if (r.ok) setResult(r.result); else setError(r.error);
  };

  return (
    <div className="cmp">
      <div className="cmp__setup db-stack">
        <label className="ai-field">
          <span>Meeting</span>
          <select className="db-input" value={meetingId} onChange={(e) => { setMeetingId(e.target.value); changed(); }}>
            {meetings.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </label>
        {rows.map((r, k) => (
          <div key={k} className="cmp__pair">
            <span className="cmp__n">{String.fromCharCode(65 + k)}</span>
            <label className="ai-field">
              <span>Provider</span>
              <select className="db-input" value={r.provider} onChange={(e) => setRow(k, { provider: e.target.value as ProviderId, model: "" })}>
                {providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </label>
            <label className="ai-field">
              <span>Model</span>
              <input className="db-input db-mono" value={r.model} list={`cmp-m-${k}`} onChange={(e) => setRow(k, { model: e.target.value })} spellCheck={false} autoComplete="off" placeholder="Type a model name" />
              <datalist id={`cmp-m-${k}`}>{(byId.get(r.provider)?.suggestions ?? []).map((m) => <option key={m} value={m} />)}</datalist>
            </label>
            {rows.length > 2 ? <button type="button" className="db-act" onClick={() => { setRows((xs) => xs.filter((_, j) => j !== k)); changed(); }}>Remove</button> : null}
          </div>
        ))}
        <p className="ai-job__meta"><em>Model names are free text; suggestions come from each provider&apos;s list after Test in Settings › AI.</em></p>
        <div className="db-row">
          {rows.length < 3 ? <button type="button" className="db-btn" onClick={() => { setRows((xs) => [...xs, { provider: "anthropic", model: "" }]); changed(); }}>Add a third model</button> : null}
          <button type="button" className="db-btn db-btn--primary" disabled={!meetingId || busy !== null} onClick={doEstimate}>{busy === "estimate" ? "Reading the transcript…" : "Estimate cost"}</button>
        </div>
      </div>

      {est ? (
        <div className="cmp__confirm" role="region" aria-label="Estimated cost">
          <h3 className="ai-h3">Estimated cost for {est.meetingTitle}</h3>
          <ul className="cmp__est">
            {est.estimates.map((e) => <li key={e.qualified}><span>{e.label}</span><span className="db-mono">{e.costLabel}</span></li>)}
          </ul>
          <p className="cmp__total">Total <b>{est.total.label}</b> <span className="ai-muted">(estimate from list prices; about {est.estimates[0]?.inputTokens.toLocaleString("en-IN")} input tokens each)</span></p>
          <label className="db-check">
            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
            <span className="db-check__label">Run it. I understand this spends credit on my own accounts.</span>
          </label>
          <div className="db-row">
            <button type="button" className="db-btn db-btn--highlight" disabled={!agree || busy !== null} onClick={doRun}>{busy === "run" ? "Running…" : `Run comparison (${est.total.label})`}</button>
            <button type="button" className="db-btn db-btn--ghost" onClick={changed}>Cancel</button>
          </div>
        </div>
      ) : null}

      {error ? <p className="db-note db-note--error" role="alert">{error}</p> : null}

      {result ? <CompareTable result={result} /> : null}
    </div>
  );
}

function CompareTable({ result }: { result: CompareResult }) {
  const n = result.pairs.length;
  return (
    <section className="cmp__result" aria-label="Results">
      <div className="cmp__scroll">
        <table className="cmp__table" style={{ ["--cols" as string]: n }}>
          <thead>
            <tr>
              <th scope="col" className="cmp__kind">Found</th>
              {result.pairs.map((p, i) => (
                <th key={p.qualified} scope="col">
                  <span className="cmp__n">{String.fromCharCode(65 + i)}</span> {p.label}
                  <small>{p.ok ? `${p.newItems.length} items · ${p.closes.length} closes · ${(p.ms / 1000).toFixed(1)}s · ${p.costLabel}${p.dropped ? ` · ${p.dropped} dropped by the quote check` : ""}` : p.error}</small>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((r, k) => (
              <tr key={k} className={r.agreed ? "cmp__agree" : "cmp__differ"}>
                <th scope="row" className="cmp__kind">{KIND[r.kind]}{r.agreed ? "" : <span className="cmp__tag">differs</span>}</th>
                {r.cells.map((c, i) => (
                  <td key={i}>
                    {c ? (
                      <>
                        <span className="cmp__text">{c.text}</span>
                        {c.person ? <span className="ai-muted"> · {c.person}</span> : null}
                        {c.dueAt ? <span className="ai-muted"> · due {new Date(c.dueAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span> : null}
                        <span className="cmp__quote">&ldquo;{c.quote}&rdquo;</span>
                      </>
                    ) : <span className="cmp__none">{result.pairs[i].ok ? "Not found" : "—"}</span>}
                  </td>
                ))}
              </tr>
            ))}
            {result.closes.map((c) => (
              <tr key={c.itemId} className={c.by.every((b, i) => b || !result.pairs[i].ok) ? "cmp__agree" : "cmp__differ"}>
                <th scope="row" className="cmp__kind">Closes</th>
                {c.by.map((b, i) => <td key={i}>{b ? <span className="cmp__text">{c.text}</span> : <span className="cmp__none">Left open</span>}</td>)}
              </tr>
            ))}
            {!result.rows.length && !result.closes.length ? <tr><td colSpan={n + 1} className="cmp__none">No model found anything in this meeting.</td></tr> : null}
          </tbody>
        </table>
      </div>
      <p className="db-note">Spent about ₹{result.totalInr.toFixed(2)} in all (estimate from list prices). Nothing was saved to your lists.</p>
    </section>
  );
}
