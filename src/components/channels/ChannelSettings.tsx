// Settings › Delivery: where the brief goes besides the note and notification on this Mac.
// One card per channel, each off until you turn it on. Secrets go to the Keychain, never the page.
import type { ReactNode } from "react";
import { removeChannelSecret, saveChannel, testChannel } from "@/app/channel-actions";
import { Button } from "@/components/Button";
import { CHANNEL_LABEL, KIND_LABEL, MESSAGE_KINDS, type ChannelId, type ChannelsFile } from "@/server/channels/config";
import { channelHealth } from "@/server/channels/health";
import { channelConfig, channelSecrets } from "@/server/channels/local";
import type { ChannelSecret } from "@/server/channels/secrets";
import { appUrl } from "@/server/local/paths";

type Flash = { ch?: string; saved?: string; test?: string; err?: string; removed?: string };

function Text({ id, name, label, hint, value, placeholder, type = "text", inputMode }: {
  id: string; name: string; label: string; hint?: ReactNode; value?: string | number; placeholder?: string; type?: string; inputMode?: "numeric" | "email" | "url";
}) {
  return (
    <div className="db-field">
      <label className="db-field__label" htmlFor={id}>{label}</label>
      <input className="db-input" id={id} name={name} type={type} defaultValue={value} placeholder={placeholder} inputMode={inputMode} autoComplete="off" spellCheck={false} />
      {hint ? <span className="db-field__hint">{hint}</span> : null}
    </div>
  );
}

function Secret({ ch, name, label, hint, placeholder, saved, where }: { ch: ChannelId; name: ChannelSecret; label: string; hint?: ReactNode; placeholder: string; saved: boolean; where: string }) {
  const id = `${ch}-${name}`;
  return (
    <div className="db-field">
      <label className="db-field__label" htmlFor={id}>{label}</label>
      <div className="ch-secret">
        <input className="db-input db-mono" id={id} name={name} type="password" autoComplete="off" spellCheck={false} placeholder={saved ? "Saved. Type to replace." : placeholder} title={saved ? `Saved ${where}` : undefined} />
        {saved ? (
          <button className="db-btn db-btn--ghost ch-secret__remove" type="submit" formAction={removeChannelSecret} name="secret" value={name} formNoValidate>
            Remove
          </button>
        ) : null}
      </div>
      {hint ? <span className="db-field__hint">{hint}</span> : null}
    </div>
  );
}

function Status({ id, file, flash, timeZone }: { id: ChannelId; file: ChannelsFile; flash: Flash; timeZone: string }) {
  const mine = flash.ch === id;
  const s = file.status[id];
  if (mine && flash.err) {
    return <p className="ch-status ch-status--bad" role="alert">{flash.err === "keychain" ? "Couldn't save to the Keychain. Nothing was changed." : "Something in the form didn't look right."}</p>;
  }
  if (mine && flash.test === "ok") return <p className="ch-status ch-status--ok" role="status">Test sent. Check {CHANNEL_LABEL[id]}.</p>;
  if (mine && flash.test === "fail") return <p className="ch-status ch-status--bad" role="alert">Test not sent: {s?.lastError?.replace(/^test: /, "") ?? "unknown error"}</p>;
  if (mine && flash.saved) return <p className="ch-status" role="status">Saved.</p>;
  if (mine && flash.removed) return <p className="ch-status" role="status">Removed.</p>;
  const h = channelHealth(file, timeZone, new Date()).find((x) => x.id === id);
  if (!h) return null;
  return <p className={`ch-status${h.state === "failed" ? " ch-status--bad" : ""}`}>Last: {h.line}</p>;
}

function Card({ id, file, flash, timeZone, lead, help, children }: { id: ChannelId; file: ChannelsFile; flash: Flash; timeZone: string; lead: string; help: ReactNode; children: ReactNode }) {
  const c = file[id];
  const failed = channelHealth(file, timeZone, new Date()).find((x) => x.id === id)?.state === "failed";
  return (
    <section className={`ch-card ch-card--${id}`} id={`ch-${id}`} aria-labelledby={`ch-${id}-title`}>
      <form action={saveChannel} className="ch-card__form">
        <input type="hidden" name="channel" value={id} />
        <div className="ch-card__head">
          <label className="db-check ch-card__toggle">
            <input className="db-switch" type="checkbox" name="enabled" defaultChecked={c.enabled} aria-labelledby={`ch-${id}-title`} />
            <span>
              <span className="ch-card__title" id={`ch-${id}-title`}>{CHANNEL_LABEL[id]}</span>
              <span className="db-field__hint">{lead}</span>
            </span>
          </label>
          <span className={`ch-pill${c.enabled ? (failed ? " ch-pill--bad" : " ch-pill--on") : ""}`}>{c.enabled ? (failed ? "Failing" : "On") : "Off"}</span>
        </div>
        <div className="ch-card__body">
          <fieldset className="ch-kinds">
            <legend className="db-field__label">Send here</legend>
            {MESSAGE_KINDS.map((k) => (
              <label key={k} className="ch-kind">
                <input type="checkbox" name={`kind_${k}`} defaultChecked={c.kinds[k]} />
                <span>{KIND_LABEL[k]}</span>
              </label>
            ))}
          </fieldset>
          {children}
          <details className="ch-help">
            <summary>How to set it up</summary>
            {help}
          </details>
          <div className="db-row ch-card__acts">
            <Button type="submit">Save</Button>
            <Button type="submit" variant="secondary" formAction={testChannel}>Send test</Button>
            <select className="db-input ch-testkind" name="testKind" aria-label="What to send as a test" defaultValue="brief">
              {MESSAGE_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </select>
          </div>
          <Status id={id} file={file} flash={flash} timeZone={timeZone} />
        </div>
      </form>
    </section>
  );
}

export function ChannelSettings({ flash, timeZone }: { flash: Flash; timeZone: string }) {
  const file = channelConfig().read();
  const where = channelSecrets().where === "keychain" ? "in the Keychain" : "in .daily-brief/channel-secrets.json";
  const has = (n: ChannelSecret) => file.secretsSet.includes(n);
  const e = file.email;
  const s = file.slack;
  const t = file.telegram;
  const w = file.whatsapp;
  return (
    <section className="db-stack db-subsection ch" id="delivery" aria-labelledby="delivery-title">
      <h2 className="db-section__title" id="delivery-title">Delivery</h2>
      <p className="db-note ch-intro">
        The brief is always written to your notes folder with a Mac notification. It can also go where you already are. Each channel is
        off until you turn it on, and choose what it gets. Tokens and passwords are kept {where}. Links point to this Mac ({appUrl()}).
      </p>

      <Card id="email" file={file} flash={flash} timeZone={timeZone} lead="Your own mail server (a Gmail app password works) or a Resend API key."
        help={
          <ol>
            <li><b>Gmail:</b> turn on 2-Step Verification, then make an app password at myaccount.google.com/apppasswords. Server smtp.gmail.com, port 587, STARTTLS, your Gmail address as the user.</li>
            <li><b>Resend:</b> verify a domain at resend.com/domains, create an API key with sending access, and use an address on that domain as From.</li>
          </ol>
        }>
        <Text id="email-to" name="to" label="Send to" value={e.to} placeholder="you@example.com" inputMode="email" />
        <fieldset className="ch-choice">
          <legend className="db-field__label">Send with</legend>
          <label><input type="radio" name="provider" value="smtp" defaultChecked={e.provider === "smtp"} /> SMTP</label>
          <label><input type="radio" name="provider" value="resend" defaultChecked={e.provider === "resend"} /> Resend</label>
        </fieldset>
        <div className="ch-grid ch-only-smtp">
          <Text id="email-host" name="smtpHost" label="SMTP server" value={e.smtpHost} placeholder="smtp.gmail.com" />
          <Text id="email-port" name="smtpPort" label="Port" value={e.smtpPort} inputMode="numeric" />
          <div className="db-field">
            <label className="db-field__label" htmlFor="email-sec">Security</label>
            <select className="db-input" id="email-sec" name="smtpSecurity" defaultValue={e.smtpSecurity}>
              <option value="starttls">STARTTLS (587)</option>
              <option value="tls">TLS (465)</option>
            </select>
          </div>
          <Text id="email-user" name="smtpUser" label="User name" value={e.smtpUser} placeholder="you@gmail.com" />
        </div>
        <div className="ch-only-smtp">
          <Secret ch="email" name="smtpPassword" label="Password or app password" placeholder="abcd efgh ijkl mnop" saved={has("smtpPassword")} where={where} />
        </div>
        <div className="ch-only-resend">
          <Secret ch="email" name="resendKey" label="Resend API key" placeholder="re_…" saved={has("resendKey")} where={where} />
        </div>
        <Text id="email-from" name="from" label="From" value={e.from} placeholder="Daily brief <brief@yourdomain.com>" hint="With SMTP, leave it empty to send from your user name." />
      </Card>

      <Card id="slack" file={file} flash={flash} timeZone={timeZone} lead="A DM from your own Slack app, or a post through an incoming webhook."
        help={
          <ol>
            <li>Go to api.slack.com/apps, <b>Create New App</b> › From scratch, in your workspace.</li>
            <li><b>Bot token:</b> under OAuth &amp; Permissions add the bot scopes chat:write, im:write and users:read (users:read.email to find people by email), install it, and copy the xoxb- token. Your member ID is in your Slack profile › ⋯ › Copy member ID.</li>
            <li><b>Nudges as you (optional):</b> add the same scopes as user scopes and paste the xoxp- user token. Without it, nudges come from the app and start with your name.</li>
            <li><b>Webhook instead:</b> turn on Incoming Webhooks, add one for a channel or your DM, and paste its URL. A webhook can&apos;t send nudges.</li>
          </ol>
        }>
        <fieldset className="ch-choice">
          <legend className="db-field__label">Send with</legend>
          <label><input type="radio" name="mode" value="bot" defaultChecked={s.mode === "bot"} /> Bot token (DM)</label>
          <label><input type="radio" name="mode" value="webhook" defaultChecked={s.mode === "webhook"} /> Incoming webhook</label>
        </fieldset>
        <div className="ch-only-bot">
          <Secret ch="slack" name="slackBot" label="Bot token" placeholder="xoxb-…" saved={has("slackBot")} where={where} />
          <Text id="slack-user" name="userId" label="Your member ID" value={s.userId} placeholder="U01ABCDEF" hint="Where the brief is sent: your DM with the app." />
          <Secret ch="slack" name="slackUser" label="User token for nudges (optional)" placeholder="xoxp-…" saved={has("slackUser")} where={where}
            hint="Nudges are only ever sent after you confirm the person and the text, every time." />
        </div>
        <div className="ch-only-webhook">
          <Secret ch="slack" name="slackWebhook" label="Webhook URL" placeholder="https://hooks.slack.com/services/…" saved={has("slackWebhook")} where={where} />
        </div>
      </Card>

      <Card id="telegram" file={file} flash={flash} timeZone={timeZone} lead="A message from your own bot. Optionally close items by replying /done 3."
        help={
          <ol>
            <li>In Telegram, message @BotFather, send /newbot and copy the token it gives you.</li>
            <li>Send your new bot any message, then open api.telegram.org/bot&lt;token&gt;/getUpdates in a browser and copy message.chat.id.</li>
            <li>Replies are read every 5 minutes while the app runs (getUpdates; nothing listens on this Mac). Only your chat counts.</li>
          </ol>
        }>
        <Secret ch="telegram" name="telegramBot" label="Bot token" placeholder="123456789:AA…" saved={has("telegramBot")} where={where} />
        <Text id="tg-chat" name="chatId" label="Chat ID" value={t.chatId} placeholder="424242424" inputMode="numeric" />
        <label className="db-check">
          <input className="db-switch" type="checkbox" name="replies" defaultChecked={t.replies} />
          <span>
            <span className="db-check__label">Close items from Telegram</span>
            <span className="db-field__hint">Reply &quot;/done 3&quot; to mark item 3 of the last brief done. Checked every 5 minutes.</span>
          </span>
        </label>
      </Card>

      <Card id="whatsapp" file={file} flash={flash} timeZone={timeZone} lead="A short WhatsApp message with the summary and a link, through Meta's Cloud API."
        help={
          <ol>
            <li>At developers.facebook.com create an app of type Business and add <b>WhatsApp</b>. Note the <b>phone number ID</b>, and add your own number as a recipient.</li>
            <li>Make a permanent token: Business Settings › System users › add one with whatsapp_business_messaging, generate a token.</li>
            <li>In WhatsApp Manager › Message templates, create a <b>Utility</b> template named daily_brief, language English, body: <code>Daily brief, {"{{1}}"}: {"{{2}}"} {"{{3}}"}</code>. Sends wait for Meta to approve it.</li>
            <li>The link is {"{{3}}"}. This Mac&apos;s address only opens on this Mac; put a link you can open from your phone, or leave it empty.</li>
          </ol>
        }>
        <div className="ch-grid">
          <Text id="wa-phone" name="phoneNumberId" label="Phone number ID" value={w.phoneNumberId} placeholder="1098765432" inputMode="numeric" />
          <Text id="wa-to" name="to" label="Your WhatsApp number" value={w.to} placeholder="+91 98123 45678" />
          <Text id="wa-template" name="template" label="Template name" value={w.template} />
          <Text id="wa-lang" name="language" label="Template language" value={w.language} />
        </div>
        <Secret ch="whatsapp" name="whatsappToken" label="Access token" placeholder="EAAG…" saved={has("whatsappToken")} where={where} />
        <Text id="wa-link" name="link" label="Link in the message" value={w.link} placeholder="Optional" inputMode="url" />
      </Card>
    </section>
  );
}

/** For Settings › Health: one line per channel that is on. */
export function ChannelHealthRows({ timeZone }: { timeZone: string }) {
  const rows = channelHealth(channelConfig().read(), timeZone, new Date());
  return (
    <>
      <dt>Delivery</dt>
      <dd>
        {rows.length ? (
          rows.map((r) => (
            <span key={r.id} className={`ch-health${r.state === "failed" ? " ch-health--bad" : ""}`}>{r.label}: {r.line}</span>
          ))
        ) : (
          "Notes and notifications on this Mac"
        )}
      </dd>
    </>
  );
}
