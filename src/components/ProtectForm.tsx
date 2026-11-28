"use client";

import { useState } from "react";
import { MIN_PASSWORD, passwordProblem, protectHtml } from "@/lib/export/protect";

/**
 * Makes the protected file in this browser: fetches the page as HTML, encrypts it with the
 * password (WebCrypto, AES-GCM, PBKDF2) and saves the file. The password stays in this form's
 * memory only and is cleared once the file is made.
 */
export function ProtectForm({ source, fileName, title }: { source: string; fileName: string; title: string }) {
  const [pw, setPw] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function make(e: React.FormEvent) {
    e.preventDefault();
    const problem = passwordProblem(pw, again);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(source, { cache: "no-store" });
      if (!res.ok) throw new Error("Couldn't read the page.");
      const file = await protectHtml(await res.text(), pw);
      const url = URL.createObjectURL(new Blob([file], { type: "text/html" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setDone(fileName);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't make the file.");
    } finally {
      setPw("");
      setAgain("");
      setBusy(false);
    }
  }

  return (
    <form className="db-stack ex-protect" onSubmit={make} autoComplete="off">
      <p className="db-lead">“{title}” as one HTML file, encrypted with a password. Send it any way you like; it opens in a browser with the password. Nothing goes to a server and the password isn’t saved.</p>
      <div className="db-field">
        <label className="db-field__label" htmlFor="ex-pw">Password</label>
        <input className="db-input" id="ex-pw" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} minLength={MIN_PASSWORD} required />
        <span className="db-field__hint">At least {MIN_PASSWORD} characters. Tell it to them another way (not in the same email).</span>
      </div>
      <div className="db-field">
        <label className="db-field__label" htmlFor="ex-pw2">Password again</label>
        <input className="db-input" id="ex-pw2" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} required />
      </div>
      <div className="db-row">
        <button className="db-btn db-btn--primary" type="submit" disabled={busy}>{busy ? "Encrypting…" : "Make protected file"}</button>
      </div>
      {error ? <p className="db-note db-note--error" role="alert">{error}</p> : null}
      {done ? <p className="db-note" role="status">Saved <span className="db-mono">{done}</span>. If the password is lost, the file can’t be opened.</p> : null}
    </form>
  );
}
