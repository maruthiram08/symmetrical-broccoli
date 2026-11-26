"use client";

// A button that asks the server for a secret (a new API token, the webhook signing secret) and shows
// it right here with Copy. The value is never put in the page until you press the button.
import { useState, useTransition } from "react";

type Result = { ok: true; value: string } | { ok: false; error: string };

export function SecretButton({ label, action, note, variant = "secondary", confirm }: {
  label: string;
  action: () => Promise<Result>;
  note?: string;
  variant?: "primary" | "secondary";
  /** Asked before running, for actions that replace an existing secret. */
  confirm?: string;
}) {
  const [value, setValue] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, start] = useTransition();

  const run = () => {
    if (confirm && !window.confirm(confirm)) return;
    setError(null);
    start(async () => {
      const r = await action();
      if (r.ok) setValue(r.value);
      else setError(r.error);
    });
  };

  const copy = async () => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="int-secret">
      {value ? (
        <div className="int-secret__shown">
          <input className="db-input db-mono int-secret__value" readOnly value={value} aria-label="Secret" onFocus={(e) => e.currentTarget.select()} />
          <button type="button" className="db-btn db-btn--primary" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
        </div>
      ) : (
        <button type="button" className={variant === "primary" ? "db-btn db-btn--primary" : "db-btn"} disabled={pending} onClick={run}>
          {pending ? "…" : label}
        </button>
      )}
      {value && note ? <p className="db-field__hint">{note}</p> : null}
      {error ? <p className="db-note db-note--error" role="alert">{error}</p> : null}
    </div>
  );
}
