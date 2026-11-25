import { Resend } from "resend";
import { env } from "@/lib/env";

let client: Resend | null = null;
function resend(): Resend {
  client ??= new Resend(env.resendKey);
  return client;
}

/** Sends one email through Resend. Throws on any API error so the caller can retry or log. */
export async function sendEmail(to: string, msg: { subject: string; html: string; text: string }): Promise<{ id: string }> {
  const { data, error } = await resend().emails.send({
    from: env.emailFrom,
    to: [to],
    subject: msg.subject,
    html: msg.html,
    text: msg.text,
  });
  if (error || !data) throw new Error(`Resend send failed: ${error?.name ?? "unknown"}: ${error?.message ?? "no data"}`);
  return { id: data.id };
}
