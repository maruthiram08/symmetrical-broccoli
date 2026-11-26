import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { SubmitOnChange } from "@/components/SubmitOnChange";
import { formatTime } from "@/lib/brief/time";
import { createWidgetToken, dismissWidgetToken, forgetAllDevices, newPairingCode, removeDevice, saveExtraction, savePhoneAccess } from "@/app/platform-actions";
import { getFlash } from "@/server/local/flash";
import { getPhoneStore, type Device } from "@/server/local/phone";
import { phoneStatus } from "@/server/local/phone-proxy";
import { extractionPrefs } from "@/server/local/prefs";

function seen(d: Device, tz: string): string {
  const added = new Intl.DateTimeFormat("en-GB", { timeZone: tz, day: "numeric", month: "short" }).format(new Date(d.createdAt));
  return d.lastSeenAt ? `Added ${added} · last used ${formatTime(d.lastSeenAt, tz)}` : `Added ${added} · not used yet`;
}

function DeviceList({ devices, tz, back }: { devices: Device[]; tz: string; back: "phone" | "widget" }) {
  if (!devices.length) return null;
  return (
    <ul className="db-plat__devices">
      {devices.map((d) => (
        <li key={d.id}>
          <span>
            {d.name}
            <small>{seen(d, tz)}</small>
          </span>
          <form action={removeDevice}>
            <input type="hidden" name="id" value={d.id} />
            <input type="hidden" name="back" value={back} />
            <Button type="submit" variant="ghost">Remove</Button>
          </form>
        </li>
      ))}
    </ul>
  );
}

/** Settings › Phone access, Phone widget and Reading model. Changed only on the Mac itself. */
export function PlatformSettings({ remote, timeZone, modelError }: { remote: boolean; timeZone: string; modelError?: boolean }) {
  if (remote) {
    return (
      <section id="phone" className="db-stack db-subsection">
        <h2 className="db-section__title">Phone access</h2>
        <p className="db-note" style={{ marginTop: 0 }}>
          You&apos;re on a paired phone. Phone access, widget tokens and the reading model can only be changed on your Mac.
        </p>
      </section>
    );
  }
  const phone = getPhoneStore();
  const state = phone.read();
  const status = phoneStatus();
  const pairing = state.enabled ? phone.activePairing() : null;
  const phones = state.devices.filter((d) => d.kind === "phone");
  const widgets = state.devices.filter((d) => d.kind === "widget");
  const widgetToken = getFlash("widgetToken");
  const prefs = extractionPrefs();
  const check = (() => { try { const v = getFlash("ollamaCheck"); return v ? (JSON.parse(v) as { ok: boolean; message: string }) : null; } catch { return null; } })();
  const base = status.url ?? "http://<your-mac>:4243";

  return (
    <>
      <section id="phone" className="db-stack db-subsection" aria-labelledby="phone-h">
        <h2 className="db-section__title" id="phone-h">Phone access</h2>
        <form action={savePhoneAccess} className="db-stack">
          <label className="db-check">
            <SubmitOnChange name="phoneAccess" defaultChecked={state.enabled} />
            <span>
              <span className="db-check__label">Open Daily brief on my phone over Wi-Fi</span>
              <span className="db-field__hint">
                Off by default: the app only answers on this Mac (127.0.0.1). When on, your phone opens it at this Mac&apos;s Wi-Fi
                address after entering a pairing code once.
              </span>
            </span>
          </label>
          <noscript><Button type="submit" variant="secondary">Save</Button></noscript>
        </form>

        <div className="db-plat__warn">
          <strong>Before you turn it on.</strong> Each paired phone gets its own key, kept in a cookie on that phone; remove a phone
          here and it is signed out. Pages travel over your Wi-Fi as plain HTTP unless you set up HTTPS (see the README), so others on
          the same network could read them. Use it on networks you trust, like home, and turn it off on shared Wi-Fi.
        </div>

        {state.enabled ? (
          <>
            <p className="db-plat__status" role="status">
              <span className={`db-plat__dot ${status.listening ? "db-plat__dot--on" : status.error ? "db-plat__dot--err" : ""}`} aria-hidden="true" />
              {status.listening ? (
                <span>On your phone, open <span className="db-plat__url">{status.url}</span></span>
              ) : (
                <span>{status.error ?? "Starting…"}</span>
              )}
            </p>
            {pairing ? (
              <div className="db-plat__code">
                <span className="db-field__hint">Pairing code</span>
                <span className="db-plat__digits" aria-label={`Pairing code ${pairing.code.split("").join(" ")}`}>{pairing.code.slice(0, 3)} {pairing.code.slice(3)}</span>
                <span className="db-field__hint">For one phone. Works until {formatTime(pairing.expiresAt, timeZone)}, {pairing.attemptsLeft} tries left.</span>
              </div>
            ) : null}
            <div className="db-row">
              <form action={newPairingCode}><Button type="submit" variant={pairing ? "secondary" : "primary"}>New pairing code</Button></form>
              {phones.length ? <form action={forgetAllDevices}><Button type="submit" variant="ghost">Sign out all phones</Button></form> : null}
            </div>
            <ol className="db-plat__steps">
              <li><b>iPhone:</b> open the address in Safari, enter the code, then Share › <b>Add to Home Screen</b>.</li>
              <li><b>Android:</b> open it in Chrome, enter the code, then ⋮ › <b>Add to Home screen</b> (or <b>Install app</b>).</li>
              <li>Today, All open and People are saved on the phone for reading offline once you use HTTPS; on plain Wi-Fi the phone needs this Mac awake and on the same network.</li>
            </ol>
            <DeviceList devices={phones} tz={timeZone} back="phone" />
          </>
        ) : null}
      </section>

      <section id="widget" className="db-stack db-subsection" aria-labelledby="widget-h">
        <h2 className="db-section__title" id="widget-h">Phone widget</h2>
        <p className="db-note" style={{ marginTop: 0 }}>
          An iOS Shortcut (or any widget app) can show <b>3 you owe today · 1 overdue</b> on your Home Screen. It reads{" "}
          <span className="db-plat__url">{base}/api/widget</span> with a widget token, which can read that line and nothing else.
          Step-by-step recipe: <span className="db-mono">docs/WIDGET.md</span>. Needs Phone access on.
        </p>
        {widgetToken ? (
          <div className="db-plat__code">
            <span className="db-field__hint">Your widget token. Copy it into the Shortcut now: it isn&apos;t shown again.</span>
            <span className="db-plat__token">{widgetToken}</span>
            <form action={dismissWidgetToken}><Button type="submit" variant="secondary">Done</Button></form>
          </div>
        ) : (
          <form action={createWidgetToken} className="db-row">
            <input className="db-input" name="name" defaultValue="iPhone widget" aria-label="Token name" maxLength={40} style={{ maxWidth: 220 }} />
            <Button type="submit" variant="secondary">Create widget token</Button>
          </form>
        )}
        <DeviceList devices={widgets} tz={timeZone} back="widget" />
      </section>

      <section id="model" className="db-stack db-subsection" aria-labelledby="model-h">
        <h2 className="db-section__title" id="model-h">Reading model</h2>
        <form action={saveExtraction} className="db-stack">
          <fieldset className="db-plat__choice" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="db-field__label" style={{ marginBottom: 8 }}>Extraction model</legend>
            <label className="db-plat__radio">
              <input type="radio" name="provider" value="claude" defaultChecked={prefs.provider === "claude"} />
              <span><b>Claude (default)</b><small>Best at Hinglish, hedged promises and closing items. About ₹3.50 a meeting, with your Anthropic key.</small></span>
            </label>
            <label className="db-plat__radio">
              <input type="radio" name="provider" value="ollama" defaultChecked={prefs.provider === "ollama"} />
              <span><b>Local (Ollama)</b><small>Transcripts never leave this computer and reading costs nothing. Needs Ollama running and a model pulled.</small></span>
            </label>
          </fieldset>
          <div className="db-plat__grid">
            <Field id="ollamaModel" name="ollamaModel" label="Ollama model" defaultValue={prefs.ollamaModel} hint="Say qwen2.5:14b or llama3.1:8b." spellCheck={false} autoComplete="off" />
            <Field id="ollamaUrl" name="ollamaUrl" label="Ollama address" defaultValue={prefs.ollamaUrl} hint="Usually http://127.0.0.1:11434" spellCheck={false} autoComplete="off" />
          </div>
          <div className="db-plat__warn">
            <strong>Expect lower quality.</strong> Local models miss more promises, close fewer items and handle Hinglish worse than
            Claude. Quotes that aren&apos;t in the transcript are still dropped. Ask, nudges and changed-decision checks keep using
            Claude when a key is set.
          </div>
          <div className="db-row">
            <Button type="submit">Save</Button>
            <Button type="submit" variant="ghost" name="test" value="1">Save and test Ollama</Button>
          </div>
          {modelError ? <p className="db-note db-note--error" role="alert">Check the model name and the address (http://host:port).</p> : null}
          {check ? <p className={`db-note${check.ok ? "" : " db-note--error"}`} role="status">{check.message}</p> : null}
        </form>
      </section>
    </>
  );
}
