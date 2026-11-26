"use server";

// Settings › Send to, Local API and Webhooks, and "Send to Jira/Linear/Notion/Todoist" on an item.
import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { TicketProvider } from "@/lib/types";
import { me } from "@/server/local/app";
import { WEBHOOK_EVENTS, type WebhookEvent } from "@/server/integrations/config";
import { liveDeps } from "@/server/integrations/runtime";
import { disconnectProvider, saveProvider, sendToTicket } from "@/server/integrations/tickets";
import { sendTest, validWebhookUrl } from "@/server/integrations/webhooks";
import { jiraSite } from "@/server/integrations/providers/jira";
import { notionId } from "@/server/integrations/providers/notion";

const providerSchema = z.enum(["jira", "linear", "notion", "todoist"]);
const str = (fd: FormData, k: string, max = 300) => String(fd.get(k) ?? "").trim().slice(0, max);

function settingsFor(p: TicketProvider, fd: FormData) {
  switch (p) {
    case "jira": {
      const site = str(fd, "site");
      return { site: site ? jiraSite(site) : "", email: str(fd, "email", 200), projectKey: str(fd, "projectKey", 40).toUpperCase(), issueType: str(fd, "issueType", 60) || "Task" };
    }
    case "linear": return { teamKey: str(fd, "teamKey", 40).toUpperCase() };
    case "notion": { const d = str(fd, "databaseId", 500); return { databaseId: d ? notionId(d) : "" }; }
    case "todoist": return { projectId: str(fd, "projectId", 60) };
  }
}

export async function saveProviderAction(fd: FormData): Promise<void> {
  const p = providerSchema.safeParse(fd.get("provider"));
  if (!p.success) redirect("/setup#integrations");
  const token = str(fd, "token", 600) || null;
  await saveProvider(liveDeps(), p.data, settingsFor(p.data, fd), token, fd.get("enabled") === "on");
  revalidatePath("/", "layout");
  redirect(`/setup?integ=${p.data}#int-${p.data}`);
}

export async function disconnectProviderAction(fd: FormData): Promise<void> {
  const p = providerSchema.safeParse(fd.get("provider"));
  if (p.success) await disconnectProvider(liveDeps(), p.data);
  revalidatePath("/", "layout");
  redirect(`/setup?integ=${p.success ? p.data : ""}#integrations`);
}

export type SendTicketResult = { ok: true; key: string; url: string; assignee: string | null } | { ok: false; error: string };

export async function sendToTicketAction(itemId: string, provider: string): Promise<SendTicketResult> {
  const p = providerSchema.safeParse(provider);
  const id = z.string().min(1).max(100).safeParse(itemId);
  if (!p.success || !id.success) return { ok: false, error: "That isn't something we can send." };
  const user = await me();
  if (!user) return { ok: false, error: "Set up Daily brief first." };
  const r = await sendToTicket(liveDeps(), user.id, id.data, p.data);
  if (!r.ok) return r;
  revalidatePath("/", "layout");
  return { ok: true, key: r.ticket.key, url: r.ticket.url, assignee: r.assignee };
}

// ---------- local API ----------

const newSecret = (prefix: string) => `${prefix}_${randomBytes(24).toString("base64url")}`;

/** Creates (or replaces) the API token and returns it, shown once in Settings. */
export async function createApiTokenAction(): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
  const deps = liveDeps();
  const value = newSecret("dbk");
  if (!(await deps.vault.set("LOCAL_API_TOKEN", value))) return { ok: false, error: "Couldn't save the token in the Keychain." };
  deps.integrations.update((s) => { s.api.createdAt = deps.now().toISOString(); });
  revalidatePath("/setup");
  return { ok: true, value };
}

export async function revokeApiTokenAction(): Promise<void> {
  const deps = liveDeps();
  await deps.vault.remove("LOCAL_API_TOKEN");
  deps.integrations.update((s) => { s.api.createdAt = null; });
  revalidatePath("/setup");
  redirect("/setup?integ=api#local-api");
}

export async function saveApiOriginsAction(fd: FormData): Promise<void> {
  const origins = str(fd, "origins", 2000).split(/[\s,]+/).filter(Boolean).flatMap((o) => {
    try {
      const u = new URL(o);
      return u.protocol === "https:" || u.protocol === "http:" ? [u.origin] : [];
    } catch {
      return [];
    }
  }).slice(0, 10);
  liveDeps().integrations.update((s) => { s.api.allowedOrigins = [...new Set(origins)]; });
  redirect("/setup?integ=api#local-api");
}

// ---------- webhooks ----------

export async function saveWebhooksAction(fd: FormData): Promise<void> {
  const deps = liveDeps();
  const raw = str(fd, "urls", 4000).split(/\s+/).filter(Boolean);
  const urls = [...new Set(raw.map(validWebhookUrl).filter((u): u is string => !!u))].slice(0, 5);
  const bad = raw.length - raw.filter((u) => validWebhookUrl(u)).length;
  const events = WEBHOOK_EVENTS.filter((e) => fd.get(`event:${e}`) === "on") as WebhookEvent[];
  let enabled = fd.get("enabled") === "on" && urls.length > 0;
  let why = bad ? "bad-url" : "";
  if (enabled && !(await deps.vault.get("WEBHOOK_SECRET"))) {
    // Never send unsigned: make a secret now; Settings shows how to see it.
    if (!(await deps.vault.set("WEBHOOK_SECRET", newSecret("whsec")))) { enabled = false; why = "secret"; }
  }
  deps.integrations.update((s) => { s.webhooks = { enabled, urls, events }; });
  revalidatePath("/setup");
  redirect(`/setup?integ=webhooks${why ? `-${why}` : ""}#webhooks`);
}

/** Creates a new signing secret, returned once. Deliveries signed with the old one stop verifying. */
export async function rotateWebhookSecretAction(): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
  const value = newSecret("whsec");
  if (!(await liveDeps().vault.set("WEBHOOK_SECRET", value))) return { ok: false, error: "Couldn't save the secret in the Keychain." };
  return { ok: true, value };
}

/** Shows the current signing secret (it is needed to verify deliveries). */
export async function revealWebhookSecretAction(): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
  const v = await liveDeps().vault.get("WEBHOOK_SECRET");
  return v ? { ok: true, value: v } : { ok: false, error: "No secret yet. Turn webhooks on first." };
}

export async function testWebhooksAction(): Promise<Array<{ url: string; status: number | null; ok: boolean }>> {
  return sendTest(liveDeps());
}
