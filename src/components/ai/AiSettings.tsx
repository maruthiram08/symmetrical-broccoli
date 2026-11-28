// Settings › AI: the model for each job, the providers (keys, base URLs, Test), prices for
// estimates, Ask's local search, and a link to Compare. Rendered on /setup in the local app.
import Link from "next/link";
import { Button } from "@/components/Button";
import { SubmitOnChange } from "@/components/SubmitOnChange";
import { removeAiKeyAction, saveAiPricesAction, saveAiProviderAction, saveAiTasksAction, saveAskSearchAction, testAiProviderAction } from "@/app/ai-settings-actions";
import { AI_TASKS, PROVIDERS, TASK_LABELS, providersFor, splitModel, type ProviderId } from "@/lib/ai/providers";
import type { Price } from "@/lib/ai/estimate";
import { PRICES_USD_PER_MTOK } from "@/lib/extract/cost";
import { aiPrefs, baseUrlOf, keyHints, keyStoreLabel, messageFor, priceFor, resolveTask, structuredOf } from "@/server/ai-config";
import { isHosted } from "@/server/mode";
import { TaskPicker, type PickerProvider } from "./TaskPicker";
import { CrossCheckSettings } from "@/components/crosscheck/CrossCheck";

const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export async function AiSettings({ flash, remote }: { flash?: { ai?: string; p?: string }; remote: boolean }) {
  if (remote) {
    return (
      <section id="ai" className="db-stack db-subsection">
        <h2 className="db-section__title">AI</h2>
        <p className="db-note" style={{ marginTop: 0 }}>You&apos;re on a paired phone. AI providers and keys can only be changed on your computer.</p>
      </section>
    );
  }
  const hosted = isHosted();
  const p = aiPrefs();
  const hints = await keyHints();
  const list = providersFor(hosted);
  const anthropicKey = !!process.env.ANTHROPIC_API_KEY;
  const ready = (id: ProviderId) => {
    const info = PROVIDERS[id];
    if (id === "anthropic") return anthropicKey;
    if (info.needsBaseUrl && !baseUrlOf(id, p)) return false;
    return !info.key || info.keyOptional || !!hints[id];
  };
  const suggestions = (id: ProviderId) => [...new Set([...PROVIDERS[id].suggestions, ...(p.providers[id]?.models ?? [])])].slice(0, 300);
  const pickers: PickerProvider[] = list.map((x) => ({
    id: x.id, label: x.label, ready: ready(x.id), suggestions: suggestions(x.id),
    defaultModel: x.id === "anthropic" || x.id === "ollama" || x.id === "claude-plan" ? resolveTask("extraction", { ...p, tasks: { extraction: { provider: x.id, model: "" } } }).model : "",
  }));
  const tasks = AI_TASKS.map((t) => {
    const r = resolveTask(t, p);
    return { id: t, label: TASK_LABELS[t].label, hint: TASK_LABELS[t].hint, provider: r.provider, model: p.tasks[t]?.model ?? (t === "extraction" && r.provider === "ollama" ? r.model : "") };
  });
  const prices: Record<string, Price> = { ...PRICES_USD_PER_MTOK, ...p.prices };
  for (const [m, v] of Object.entries(p.providers.openrouter?.pricing ?? {})) prices[`openrouter:${m}`] ??= v;
  const used = [...new Set(AI_TASKS.map((t) => resolveTask(t, p).qualified))].filter((q) => splitModel(q).provider !== "ollama" && splitModel(q).provider !== "claude-plan");
  const problems = (Object.entries(p.problems) as Array<[ProviderId, { kind: "auth" | "credit"; at: string }]>).filter(([id]) => list.some((x) => x.id === id));
  const flashOk = flash?.ai === "saved" ? "Saved." : null;
  const flashErr = flash?.ai === "badkey" ? "That key has characters that can't be stored. Paste just the key." : flash?.ai === "badurl" ? "Use an http(s) address with no user name or password, like https://host/v1." : flash?.ai === "badmodel" ? "Model names are letters, digits and . _ : / @ + -" : null;

  return (
    <section id="ai" className="db-stack db-subsection ai" aria-labelledby="ai-h">
      <h2 className="db-section__title" id="ai-h">AI</h2>
      <p className="db-note" style={{ marginTop: 0 }}>
        Pick a provider and model for each job. Anthropic stays the default; nothing changes until you pick something else. Each provider uses your
        own key, kept in {keyStoreLabel()}. Costs are estimates from list prices.
      </p>
      {problems.map(([id, x]) => (
        <div key={id} className="db-banner ai-banner" role="alert">
          <span><b>{PROVIDERS[id].label}:</b> {messageFor(id, x.kind)} <span className="ai-muted">Since {when(x.at)}.</span></span>
          <a className="db-act" href={`#ai-${id}`}>Fix</a>
        </div>
      ))}
      {flashErr ? <p className="db-note db-note--error" role="alert">{flashErr}</p> : null}

      <div id="ai-jobs" className="ai-block">
        <h3 className="ai-h3">Models for each job</h3>
        <TaskPicker tasks={tasks} providers={pickers} prices={prices} action={saveAiTasksAction} />
        {flashOk && !flash?.p ? <p className="db-note" role="status">{flashOk}</p> : null}
        <p className="db-note">
          Extraction on any provider uses the same prompt and output schema (JSON schema or a tool call), and every quote is still checked against the
          transcript. <Link href="/setup/compare">Compare models on a past meeting</Link>.
        </p>
      </div>
      <CrossCheckSettings />

      <div className="ai-block">
        <h3 className="ai-h3">Providers</h3>
        <ul className="ai-providers">
          {list.map((x) => {
            const pp = p.providers[x.id];
            const t = pp?.lastTest;
            const shared = x.sdk === "openai" || x.sdk === "groq" || x.sdk === "mistral" || x.sdk === "openrouter" || x.sdk === "ollama";
            const choose = x.id !== "gemini" && x.id !== "ollama" && x.id !== "anthropic" && x.id !== "claude-plan";
            return (
              <li key={x.id} id={`ai-${x.id}`} className="ai-prov">
                <details open={flash?.p === x.id || undefined}>
                  <summary>
                    <span className={`db-plat__dot ${ready(x.id) ? "db-plat__dot--on" : ""}`} aria-hidden="true" />
                    <span className="ai-prov__name">{x.label}</span>
                    <span className="ai-prov__state">{ready(x.id) ? (x.key ? (x.id === "anthropic" ? "Key set" : hints[x.id] ? `Key ${hints[x.id]}` : "No key needed") : x.local ? "On this computer" : "Ready") : x.needsBaseUrl ? "Needs a base URL" : "No key yet"}</span>
                  </summary>
                  <div className="ai-prov__body">
                    {x.note ? <p className="ai-prov__note">{x.note}</p> : null}
                    {x.id === "anthropic" ? (
                      <p className="ai-prov__note">
                        The Anthropic key works as before: ANTHROPIC_API_KEY in .env.local, or the Keychain for the Mac app (npm run keychain:import). {anthropicKey ? "It is set." : "It isn't set."}
                      </p>
                    ) : null}
                    {x.id !== "anthropic" ? (
                      <form action={saveAiProviderAction} className="ai-prov__form">
                        <input type="hidden" name="provider" value={x.id} />
                        {x.key ? (
                          <label className="ai-field">
                            <span>API key{x.keyOptional ? " (if your server wants one)" : ""}</span>
                            <input className="db-input db-mono" type="password" name="key" autoComplete="off" spellCheck={false}
                              placeholder={hints[x.id] ? `Saved (${hints[x.id]}). Paste a new one to replace it.` : "Paste your key"} />
                            {x.keyUrl ? <small>Get one at <a href={x.keyUrl} target="_blank" rel="noreferrer">{new URL(x.keyUrl).host}</a>.</small> : null}
                          </label>
                        ) : null}
                        {shared ? (
                          <label className="ai-field">
                            <span>Base URL{x.needsBaseUrl ? "" : " (optional)"}</span>
                            <input className="db-input db-mono" name="baseUrl" defaultValue={pp?.baseUrl ?? (x.id === "ollama" ? baseUrlOf("ollama", p) ?? "" : "")}
                              placeholder={x.baseUrl ?? (x.needsBaseUrl ? "http://127.0.0.1:1234/v1" : "The SDK's default")} spellCheck={false} autoComplete="off" />
                          </label>
                        ) : null}
                        {choose ? (
                          <label className="ai-field">
                            <span>Structured output for extraction</span>
                            <select className="db-input" name="structured" defaultValue={structuredOf(x.id, p)}>
                              <option value="tool">Tool call (function calling)</option>
                              <option value="json_schema">JSON schema (response format)</option>
                            </select>
                          </label>
                        ) : null}
                        <div className="db-row">
                          <Button type="submit" variant="secondary">Save</Button>
                          <Button type="submit" variant="ghost" name="test" value="1">Save and test</Button>
                        </div>
                      </form>
                    ) : (
                      <form action={testAiProviderAction} className="db-row">
                        <input type="hidden" name="provider" value={x.id} />
                        <Button type="submit" variant="secondary">Test</Button>
                      </form>
                    )}
                    {x.key && x.id !== "anthropic" && hints[x.id] ? (
                      <form action={removeAiKeyAction}>
                        <input type="hidden" name="provider" value={x.id} />
                        <button className="db-act" type="submit">Remove key</button>
                      </form>
                    ) : null}
                    {t ? (
                      <p className={`ai-test ${t.ok ? "ai-test--ok" : "ai-test--err"}`} role="status">
                        {t.ok ? "Works. " : "Didn't work. "}{t.message} <span className="ai-muted">Tested {when(t.at)}.</span>
                      </p>
                    ) : null}
                    {x.id === "claude-plan" ? <p className="ai-prov__note">Test runs one short request on your plan.</p> : x.local ? null : <p className="ai-prov__note">Test lists the provider&apos;s models, which costs nothing, and keeps them as suggestions.</p>}
                  </div>
                </details>
              </li>
            );
          })}
        </ul>
      </div>

      <form id="ai-prices" action={saveAiPricesAction} className="ai-block">
        <h3 className="ai-h3">Prices for estimates</h3>
        <p className="db-note" style={{ marginTop: 0 }}>
          USD per million tokens. Anthropic&apos;s are built in (placeholders in cost.ts) and OpenRouter&apos;s come from its model list; enter others from
          your provider&apos;s pricing page. Only used for estimates.
        </p>
        <table className="ai-prices">
          <thead><tr><th>Model</th><th>Input</th><th>Output</th><th /></tr></thead>
          <tbody>
            {used.map((q) => {
              const pr = priceFor(q, p);
              const mine = pr?.source === "yours";
              const fixed = pr && !mine;
              return (
                <tr key={q}>
                  <td className="db-mono">{q}</td>
                  {fixed ? (
                    <><td>{pr.input}</td><td>{pr.output}</td><td className="ai-muted">{pr.source === "anthropic" ? "built in" : "OpenRouter"}</td></>
                  ) : (
                    <>
                      <td><input className="db-input ai-num" name={`price.in.${q}`} inputMode="decimal" defaultValue={mine ? pr.input : ""} aria-label={`Input price for ${q}`} /></td>
                      <td><input className="db-input ai-num" name={`price.out.${q}`} inputMode="decimal" defaultValue={mine ? pr.output : ""} aria-label={`Output price for ${q}`} /></td>
                      <td>{mine ? <label className="ai-muted"><input type="checkbox" name={`price.clear.${q}`} value="1" /> clear</label> : <span className="ai-muted">unknown</span>}</td>
                    </>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="db-row"><Button type="submit" variant="secondary">Save prices</Button></div>
      </form>

      <form id="ai-search" action={saveAskSearchAction} className="ai-block db-stack">
        <h3 className="ai-h3">Search for Ask</h3>
        <label className="db-check">
          <SubmitOnChange name="localOnly" defaultChecked={p.search.localOnly} />
          <span>
            <span className="db-check__label">Search on this Mac only</span>
            <span className="db-field__hint">
              Finding what a question is about runs on this computer: items, meeting summaries, transcripts from local recorder files, and notes,
              ranked with BM25. Only the top passages go to the model you picked for Ask. On by default.
            </span>
          </span>
        </label>
        <div className="db-plat__grid">
          <label className="ai-field">
            <span>Embeddings (optional)</span>
            <select className="db-input" name="embeddings" defaultValue={p.search.embeddings}>
              <option value="off">Off: BM25 only, nothing to install</option>
              <option value="ollama">Ollama on this computer</option>
              <option value="provider" disabled={p.search.localOnly}>OpenAI-compatible provider (needs local-only off)</option>
            </select>
          </label>
          <label className="ai-field">
            <span>Embedding model</span>
            <input className="db-input db-mono" name="embedModel" defaultValue={p.search.embedModel} placeholder="Model name you pulled or your provider offers" spellCheck={false} autoComplete="off" />
          </label>
        </div>
        <label className="ai-field" style={{ maxWidth: 320 }}>
          <span>Embedding provider (local-only off)</span>
          <select className="db-input" name="embedProvider" defaultValue={p.search.embedProvider}>
            <option value="openai">OpenAI</option>
            <option value="compatible">OpenAI-compatible base URL</option>
          </select>
        </label>
        <div className="db-row"><Button type="submit" variant="secondary">Save search</Button></div>
      </form>
    </section>
  );
}
