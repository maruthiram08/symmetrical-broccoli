"use client";

// Settings › Webhooks › Send a test: one signed "ping" to every URL, with each answer shown.
import { useState, useTransition } from "react";
import { testWebhooksAction } from "@/app/integrations-actions";

export function WebhookTest() {
  const [pending, start] = useTransition();
  const [out, setOut] = useState<Array<{ url: string; status: number | null; ok: boolean }> | null>(null);
  return (
    <span className="int-test">
      <button type="button" className="db-btn" disabled={pending} onClick={() => start(async () => setOut(await testWebhooksAction()))}>
        {pending ? "Sending…" : "Send a test"}
      </button>
      {out ? (
        <span className="int-test__out" role="status">
          {out.map((r) => (
            <span key={r.url} className={r.ok ? "int-test__ok" : "int-test__bad"}>
              {r.ok ? `${r.status} OK` : r.status ? `Answered ${r.status}` : "No answer"}
            </span>
          ))}
        </span>
      ) : null}
    </span>
  );
}
