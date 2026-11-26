// Hosted delivery of the daily brief: email through Resend, and Slack when the user added a
// webhook. Replaces the local app's "write the note and show a notification" (publishLocal).
import { escapeHtml, renderEmail, type EmailLinks } from "@/lib/email/render";
import type { BriefModel, User } from "@/lib/types";
import type { Delivery } from "./store";

type Fetch = typeof fetch;

export interface DeliverCtx {
  appUrl: string;
  resendKey: string;
  emailFrom: string;
  delivery: Delivery;
  /** Manager brief lines (teams), already rendered as plain text, or none. */
  team?: string[];
  fetch?: Fetch;
}

export function emailLinks(appUrl: string): EmailLinks {
  return {
    base: appUrl,
    // Done and Wrong open the item, where you're signed in; mail scanners can't change anything with a GET.
    actionUrl: (itemId) => `${appUrl}/item/${encodeURIComponent(itemId)}`,
    downloadUrl: `${appUrl}/api/account/export`,
    deleteUrl: `${appUrl}/account`,
  };
}

/** Send one email through Resend. The idempotency key stops a retried cron run sending it twice. */
export async function sendEmail(
  ctx: Pick<DeliverCtx, "resendKey" | "emailFrom" | "fetch">,
  to: string,
  msg: { subject: string; html: string; text: string },
  idempotencyKey: string,
): Promise<string> {
  const res = await (ctx.fetch ?? fetch)("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${ctx.resendKey}`, "content-type": "application/json", "idempotency-key": idempotencyKey },
    body: JSON.stringify({ from: ctx.emailFrom, to: [to], subject: msg.subject, html: msg.html, text: msg.text }),
  });
  const body = (await res.json().catch(() => ({}))) as { id?: string; name?: string };
  if (!res.ok || !body.id) throw new Error(`Resend send failed: HTTP ${res.status} ${body.name ?? ""}`.trim());
  return body.id;
}

/** A short Slack message: the counts and the first few things you owe. */
export function slackText(model: BriefModel, appUrl: string, team: string[] = []): string {
  const lines = [`*${model.subject}*`];
  if (model.empty === "no_meetings") lines.push("No meetings today.");
  else if (model.empty === "nothing_owed") lines.push("Nothing owed. Go home.");
  for (const l of model.youOwe.slice(0, 5)) lines.push(`• ${l.text}${l.lateLabel ? ` _(${l.lateLabel})_` : l.dueLabel ? ` _(${l.dueLabel})_` : ""}`);
  if (model.youOwe.length > 5) lines.push(`…and ${model.youOwe.length - 5} more`);
  if (model.waitingOn.length) lines.push(`Waiting on ${model.waitingOn.length}.`);
  if (team.length) lines.push("", "*Your team*", ...team.map((t) => `• ${t}`));
  lines.push(`<${appUrl}|Open Daily brief>`);
  return lines.join("\n");
}

/** Only Slack's own webhook host, so a stored URL can't make the server call anywhere else. */
export const isSlackWebhook = (url: string) => /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+$/.test(url);

export async function sendSlack(webhook: string, text: string, f: Fetch = fetch): Promise<void> {
  if (!isSlackWebhook(webhook)) throw new Error("Slack webhook URL is not a hooks.slack.com URL");
  const res = await f(webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
  if (!res.ok) throw new Error(`Slack webhook failed: HTTP ${res.status}`);
}

function withTeam(html: string, text: string, team: string[]): { html: string; text: string } {
  if (!team.length) return { html, text };
  const block = `<div style="max-width:600px;margin:0 auto;padding:0 24px 32px;font-family:-apple-system,system-ui,sans-serif;font-size:14px;line-height:20px;color:#525252" class="em-muted"><strong>Your team</strong><br>${team.map((t) => escapeHtml(t)).join("<br>")}</div>`;
  return { html: html.includes("</body>") ? html.replace("</body>", `${block}</body>`) : html + block, text: `${text}\nYour team\n${team.map((t) => `- ${t}`).join("\n")}\n` };
}

/**
 * Hand the finished brief to the user. Email unless they turned it off, Slack when set up.
 * Throws when every channel failed, so deliver retries on the next run; one channel working is enough.
 */
export async function publishHosted(user: User, model: BriefModel, _markdown: string, ctx: DeliverCtx): Promise<{ id: string }> {
  const ids: string[] = [];
  const errors: unknown[] = [];
  const team = ctx.team ?? [];
  if (ctx.delivery.email) {
    try {
      const msg = renderEmail(model, emailLinks(ctx.appUrl));
      const { html, text } = withTeam(msg.html, msg.text, team);
      ids.push(await sendEmail(ctx, user.email, { subject: msg.subject, html, text }, `brief-${user.id}-${model.date}`));
    } catch (e) { errors.push(e); }
  }
  if (ctx.delivery.slackWebhook) {
    try {
      await sendSlack(ctx.delivery.slackWebhook, slackText(model, ctx.appUrl, team), ctx.fetch);
      ids.push("slack");
    } catch (e) { errors.push(e); }
  }
  if (!ids.length) throw errors[0] instanceof Error ? errors[0] : new Error("no delivery channel is on");
  return { id: ids.join(",") };
}
