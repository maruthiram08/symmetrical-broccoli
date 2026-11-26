"use client";

// Settings › AI › Models for each job: a provider and a free-text model per job, with the provider's
// suggestions (editable) and a cost estimate that follows what you type.
import { useState } from "react";
import { estimateLabel, type Price } from "@/lib/ai/estimate";
import { qualifiedModel, type AiTask, type ProviderId } from "@/lib/ai/providers";

export interface PickerProvider { id: ProviderId; label: string; ready: boolean; suggestions: string[]; defaultModel: string }
export interface PickerTask { id: AiTask; label: string; hint: string; provider: ProviderId; model: string }

export function TaskPicker({ tasks, providers, prices, action }: {
  tasks: PickerTask[];
  providers: PickerProvider[];
  prices: Record<string, Price>;
  action: (fd: FormData) => Promise<void>;
}) {
  const [rows, setRows] = useState(tasks.map((t) => ({ provider: t.provider, model: t.model })));
  const byId = new Map(providers.map((p) => [p.id, p]));
  return (
    <form action={action} className="ai-jobs">
      {tasks.map((t, k) => {
        const r = rows[k];
        const p = byId.get(r.provider);
        const model = r.model.trim() || p?.defaultModel || "";
        const set = (patch: Partial<typeof r>) => setRows((xs) => xs.map((x, j) => (j === k ? { ...x, ...patch } : x)));
        return (
          <fieldset key={t.id} className="ai-job">
            <legend className="ai-job__label">{t.label}</legend>
            <p className="ai-job__hint">{t.hint}</p>
            <div className="ai-job__fields">
              <label className="ai-field">
                <span>Provider</span>
                <select className="db-input" name={`${t.id}.provider`} value={r.provider} onChange={(e) => set({ provider: e.target.value as ProviderId, model: "" })}>
                  {providers.map((x) => (
                    <option key={x.id} value={x.id}>{x.label}{x.ready ? "" : " (not set up)"}</option>
                  ))}
                </select>
              </label>
              <label className="ai-field">
                <span>Model</span>
                <input className="db-input db-mono" name={`${t.id}.model`} value={r.model} list={`ai-models-${t.id}`} spellCheck={false} autoComplete="off"
                  placeholder={p?.defaultModel || "Type the model name"} onChange={(e) => set({ model: e.target.value })} maxLength={160} />
                <datalist id={`ai-models-${t.id}`}>
                  {(p?.suggestions ?? []).map((m) => <option key={m} value={m} />)}
                </datalist>
              </label>
            </div>
            <p className="ai-job__meta">
              {p && p.suggestions.length ? (
                <span>Suggestions: <span className="ai-sugg">{p.suggestions.slice(0, 4).map((m) => (
                  <button key={m} type="button" className="ai-chip" onClick={() => set({ model: m })}>{m}</button>
                ))}</span> <em>editable, type any model name</em></span>
              ) : (
                <span><em>Type any model name your provider offers. Test the provider to fill suggestions from its own list.</em></span>
              )}
              <span className="ai-job__cost">{model ? estimateLabel(qualifiedModel(r.provider, model), prices, t.id) : "Pick a model"}</span>
            </p>
          </fieldset>
        );
      })}
      <div className="db-row">
        <button className="db-btn db-btn--primary" type="submit">Save models</button>
      </div>
    </form>
  );
}
