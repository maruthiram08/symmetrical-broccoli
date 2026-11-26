// Settings › Send to (Jira, Linear, Notion, Todoist), Local API and Webhooks. All off by default.
// Tokens go to the Keychain (a 0600 file outside the Mac app) and are never shown again, only their
// last four characters.
import { switchOn } from "./switch";
import {
  createApiTokenAction,
  disconnectProviderAction,
  revealWebhookSecretAction,
  revokeApiTokenAction,
  rotateWebhookSecretAction,
  saveApiOriginsAction,
  saveProviderAction,
  saveWebhooksAction,
} from "@/app/integrations-actions";
import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { formatTime, localDate } from "@/lib/brief/time";
import type { TicketProvider } from "@/lib/types";
import { getIntegrations, WEBHOOK_EVENTS, type IntegrationsState, type ProviderConfigs } from "@/server/integrations/config";
import { PROVIDER_IDS, PROVIDERS, TOKEN } from "@/server/integrations/tickets";
import { getVault, lastFour } from "@/server/integrations/vault";
import { PORT } from "@/server/local/paths";
import { SecretButton } from "./SecretButton";
import { WebhookTest } from "./WebhookTest";

const TOKEN_HELP: Record<TicketProvider, { label: string; hint: string }> = {
  jira: { label: "API token", hint: "id.atlassian.com › Security › Create and manage API tokens." },
  linear: { label: "Personal API key", hint: "Linear › Settings › Security & access › Personal API keys." },
  notion: { label: "Internal integration secret", hint: "notion.so/profile/integrations › New integration. Then share the database with it (••• › Connections)." },
  todoist: { label: "API token", hint: "Todoist › Settings › Integrations › Developer." },
};

const EVENT_LABEL: Record<string, string> = {
  "item.created": "Item created",
  "item.closed": "Item closed",
  "decision.made": "Decision made",
};

export async function IntegrationsSettings({ flash, timeZone }: { flash?: string; timeZone: string }) {
  const st = getIntegrations().read();
  const vault = getVault();
  const saved = Object.fromEntries(await Promise.all(PROVIDER_IDS.map(async (p) => [p, lastFour(await vault.get(TOKEN[p]))] as const))) as Record<TicketProvider, string | null>;
  const apiToken = await vault.get("LOCAL_API_TOKEN");
  const hasSecret = !!(await vault.get("WEBHOOK_SECRET"));
  const where = vault.where === "keychain" ? "the Keychain" : "a private file on this Mac (.daily-brief/secrets.json)";
  const today = localDate(new Date(), timeZone);
  const at = (iso: string | null | undefined) => {
    if (!iso) return "Not yet";
    const d = localDate(new Date(iso), timeZone);
    return `${d === today ? "Today" : d}, ${formatTime(iso, timeZone)}`;
  };
  const anyOn = PROVIDER_IDS.some((p) => st.providers[p].enabled);

  return (
    <>
      <section id="integrations" className="db-stack db-subsection int" aria-labelledby="int-title">
        <h2 className="db-section__title" id="int-title">Send to</h2>
        <p className="db-note int-lead">
          Turn an item into a ticket from its actions or the Start this panel: title, the quote, the meeting and date, and a link
          back here. It&apos;s assigned to the person when their name matches someone there. Off until you add your own token,
          which stays in {where}.
        </p>
        <div className="int-cards">
          {PROVIDER_IDS.map((p) => (
            <ProviderCard key={p} id={p} cfg={st.providers[p]} check={st.checks[p]} saved={saved[p]} open={flash === p} />
          ))}
        </div>
        {anyOn ? (
          <p className="db-field__hint">
            When a ticket is closed there, its item closes here (&ldquo;Closed in Linear&rdquo;). Checked every 30 minutes, only for
            open items with a ticket. Last check: {at(st.ticketSyncAt)}.
          </p>
        ) : null}
      </section>

      <section id="local-api" className="db-stack db-subsection int" aria-labelledby="api-title">
        <h2 className="db-section__title" id="api-title">Local API</h2>
        <p className="db-note int-lead">
          A REST API on this Mac for your own scripts: items, decisions, people and meetings, and adding or closing items. Only
          localhost is served, browsers from other sites are refused, and it allows 120 requests a minute. See{" "}
          <span className="db-mono">docs/API.md</span>.
        </p>
        <div className="int-panel">
          <div className="int-panel__head">
            <span className={`int-pill${apiToken ? " int-pill--on" : ""}`}>{apiToken ? "On" : "Off"}</span>
            <span className="int-panel__status">
              {apiToken ? <>Token <span className="db-mono">{lastFour(apiToken)}</span>, made {at(st.api.createdAt)}</> : "No token yet. Nothing answers until you make one."}
            </span>
          </div>
          <div className="db-row">
            <SecretButton
              label={apiToken ? "Make a new token" : "Create a token"}
              variant={apiToken ? "secondary" : "primary"}
              action={createApiTokenAction}
              confirm={apiToken ? "Make a new token? The old one stops working." : undefined}
              note="Copy it now: it isn't shown again. Send it as Authorization: Bearer <token>."
            />
            {apiToken ? (
              <form action={revokeApiTokenAction}>
                <Button type="submit" variant="ghost">Turn off</Button>
              </form>
            ) : null}
          </div>
          <pre className="int-code db-mono" aria-label="Example">{`curl -H "Authorization: Bearer $DAILY_BRIEF_TOKEN" \\
  http://localhost:${PORT}/api/v1/items?status=open`}</pre>
          <form action={saveApiOriginsAction} className="db-stack int-origins">
            <Field
              id="origins"
              name="origins"
              label="Also allow these browser origins"
              hint="Optional. Pages on this Mac (localhost) are always allowed; pages anywhere else are refused unless listed here."
              placeholder="https://my-dashboard.example"
              defaultValue={st.api.allowedOrigins.join(" ")}
            />
            <div className="db-row"><Button type="submit" variant="secondary">Save origins</Button></div>
          </form>
        </div>
      </section>

      <section id="webhooks" className="db-stack db-subsection int" aria-labelledby="wh-title">
        <h2 className="db-section__title" id="wh-title">Webhooks</h2>
        <p className="db-note int-lead">
          Post a signed JSON event to your own URL when an item is created or closed, or a decision is made. Signed with
          HMAC-SHA256 in <span className="db-mono">X-Daily-Brief-Signature</span>; failed deliveries are retried for about 7
          hours. Off by default.
        </p>
        <WebhooksForm st={st} hasSecret={hasSecret} flash={flash} />
        {st.recent.length ? <Recent st={st} at={at} /> : null}
      </section>
    </>
  );
}

function ProviderCard({ id, cfg, check, saved, open }: {
  id: TicketProvider;
  cfg: ProviderConfigs[TicketProvider];
  check?: IntegrationsState["checks"][TicketProvider];
  saved: string | null;
  open: boolean;
}) {
  const label = PROVIDERS[id].label;
  const needs = !cfg.enabled && check && !check.ok;
  const status = cfg.enabled ? check?.message ?? "On" : needs ? check.message : saved ? "Off · token saved" : "Off";
  const help = TOKEN_HELP[id];
  return (
    <details className="int-card" id={`int-${id}`} open={open || undefined}>
      <summary className="int-card__sum">
        <span className="int-card__name">{label}</span>
        <span className={`int-pill${cfg.enabled ? " int-pill--on" : needs ? " int-pill--warn" : ""}`}>{cfg.enabled ? "On" : needs ? "Check" : "Off"}</span>
        <span className="int-card__status">{status}</span>
      </summary>
      <form action={saveProviderAction} className="db-stack int-card__form">
        <input type="hidden" name="provider" value={id} />
        <Fields id={id} cfg={cfg} />
        <Field
          id={`${id}-token`}
          name="token"
          type="password"
          label={help.label}
          hint={saved ? `Saved (${saved}). Leave empty to keep it. ${help.hint}` : help.hint}
          placeholder={saved ? "Saved" : ""}
          autoComplete="off"
          spellCheck={false}
        />
        <label className="db-check">
          <input className="db-switch" type="checkbox" role="switch" name="enabled" defaultChecked={switchOn(cfg.enabled, saved)} />
          <span>
            <span className="db-check__label">Show &ldquo;Send to {label}&rdquo; on items</span>
            <span className="db-field__hint">Saving tests the token. It&apos;s switched on only when the test passes.</span>
          </span>
        </label>
        {check && open && !check.ok ? (
          <p className="db-note db-note--error" role="alert" style={{ marginTop: 0 }}>{check.message}</p>
        ) : null}
        <div className="db-row">
          <Button type="submit">Save and test</Button>
          {saved ? (
            <Button type="submit" variant="ghost" formAction={disconnectProviderAction} formNoValidate>
              Forget token
            </Button>
          ) : null}
        </div>
      </form>
    </details>
  );
}

function Fields({ id, cfg }: { id: TicketProvider; cfg: ProviderConfigs[TicketProvider] }) {
  if (id === "jira") {
    const c = cfg as ProviderConfigs["jira"];
    return (
      <>
        <Field id="jira-site" name="site" label="Jira site" placeholder="https://your-team.atlassian.net" defaultValue={c.site} />
        <Field id="jira-email" name="email" type="email" label="Your Atlassian email" hint="Jira API tokens sign in with your email." defaultValue={c.email} autoComplete="email" />
        <div className="int-two">
          <Field id="jira-project" name="projectKey" label="Project key" placeholder="OPS" defaultValue={c.projectKey} />
          <Field id="jira-type" name="issueType" label="Issue type" placeholder="Task" defaultValue={c.issueType} />
        </div>
      </>
    );
  }
  if (id === "linear") {
    const c = cfg as ProviderConfigs["linear"];
    return <Field id="linear-team" name="teamKey" label="Team key" hint="The letters before issue numbers, like ENG in ENG-123." placeholder="ENG" defaultValue={c.teamKey} />;
  }
  if (id === "notion") {
    const c = cfg as ProviderConfigs["notion"];
    return (
      <Field
        id="notion-db"
        name="databaseId"
        label="Database"
        hint={c.titleProperty ? `Titles go in “${c.titleProperty}”${c.peopleProperty ? `, the assignee in “${c.peopleProperty}”` : ""}. A Status of Done closes the item.` : "Paste the database's link or id."}
        placeholder="https://www.notion.so/…"
        defaultValue={c.databaseId}
      />
    );
  }
  const c = cfg as ProviderConfigs["todoist"];
  return <Field id="todoist-project" name="projectId" label="Project id" hint="Optional: your Inbox when empty. Assignees need a shared project." placeholder="Inbox" defaultValue={c.projectId} />;
}

function WebhooksForm({ st, hasSecret, flash }: { st: IntegrationsState; hasSecret: boolean; flash?: string }) {
  const w = st.webhooks;
  return (
    <div className="int-panel">
      <form action={saveWebhooksAction} className="db-stack">
        <label className="db-check">
          <input className="db-switch" type="checkbox" role="switch" name="enabled" defaultChecked={w.enabled} />
          <span>
            <span className="db-check__label">Send webhooks</span>
            <span className="db-field__hint">Changes from before you switch this on are never sent.</span>
          </span>
        </label>
        <div className="db-field">
          <label className="db-field__label" htmlFor="wh-urls">URLs</label>
          <textarea id="wh-urls" name="urls" className="db-input int-textarea db-mono" rows={2} placeholder="https://example.com/hooks/daily-brief" defaultValue={w.urls.join("\n")} />
          <span className="db-field__hint">One per line, up to 5.</span>
        </div>
        <fieldset className="int-events">
          <legend className="db-field__label">Events</legend>
          {WEBHOOK_EVENTS.map((e) => (
            <label key={e} className="int-event">
              <input type="checkbox" name={`event:${e}`} defaultChecked={w.events.includes(e)} />
              <span>{EVENT_LABEL[e]}</span>
              <span className="db-mono int-event__id">{e}</span>
            </label>
          ))}
        </fieldset>
        {flash === "webhooks-bad-url" ? <p className="db-note db-note--error" role="alert" style={{ marginTop: 0 }}>Some URLs weren&apos;t http(s) links and were left out.</p> : null}
        {flash === "webhooks-secret" ? <p className="db-note db-note--error" role="alert" style={{ marginTop: 0 }}>Couldn&apos;t save a signing secret, so webhooks stay off.</p> : null}
        <div className="db-row"><Button type="submit">Save</Button></div>
      </form>
      {hasSecret ? (
        <div className="int-secret-row">
          <span className="db-field__label">Signing secret</span>
          <div className="db-row">
            <SecretButton label="Show secret" action={revealWebhookSecretAction} />
            <SecretButton label="New secret" action={rotateWebhookSecretAction} confirm="Make a new signing secret? Your endpoint must use the new one." note="Update your endpoint with this secret." />
            {w.enabled && w.urls.length ? <WebhookTest /> : null}
          </div>
        </div>
      ) : null}
      {w.enabled ? <p className="db-field__hint">Outbox: {st.outbox.length ? `${st.outbox.length} waiting to retry` : "empty"}.</p> : null}
    </div>
  );
}

function Recent({ st, at }: { st: IntegrationsState; at: (iso: string) => string }) {
  return (
    <div className="int-recent">
      <h3 className="int-recent__title">Recent deliveries</h3>
      <ul>
        {[...st.recent].reverse().slice(0, 8).map((d) => (
          <li key={`${d.id}-${d.attempts}`} className={`int-recent__row int-recent__row--${d.outcome}`}>
            <span className="int-recent__ev db-mono">{d.event}</span>
            <span className="int-recent__url">{hostOf(d.url)}</span>
            <span className="int-recent__out">{d.outcome === "delivered" ? `Delivered (${d.status})` : d.outcome === "retrying" ? `Retrying · ${d.status ?? "no answer"}` : `Gave up after ${d.attempts}`}</span>
            <span className="int-recent__at">{at(d.at)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
