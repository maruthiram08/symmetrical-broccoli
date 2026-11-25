import { env } from "@/lib/env";
import { extractMeeting } from "@/lib/extract/extract";
import { costInr } from "@/lib/extract/cost";
import { buildBrief } from "@/lib/brief/build";
import { renderMarkdown } from "@/lib/brief/markdown";
import { renderEmail } from "@/lib/email/render";
import { sendEmail } from "@/lib/email/send";
import { actionUrl, accountUrl } from "@/lib/links";
import type { Deps } from "@/server/jobs/types";
import { SupabaseStore } from "@/server/supabase-store";
import { McpWisprClient } from "@/server/wispr/client";
import type { WisprAuthContext } from "@/server/wispr/oauth";

let store: SupabaseStore | null = null;
export function getStore(): SupabaseStore {
  store ??= new SupabaseStore();
  return store;
}

export function wisprAuthContext(userId: string, now: () => Date = () => new Date()): WisprAuthContext {
  const s = getStore();
  return { userId, store: s, clients: s, appUrl: env.appUrl, serverUrl: env.wisprMcpUrl, now };
}

/** Production dependencies for the jobs. */
export function buildDeps(): Deps {
  const now = () => new Date();
  return {
    store: getStore(),
    wispr: (userId) => new McpWisprClient(wisprAuthContext(userId, now)),
    extract: (input) => extractMeeting(input),
    costInr,
    model: env.extractionModel,
    buildBrief,
    renderMarkdown,
    renderEmail,
    sendEmail,
    links: { base: env.appUrl, actionUrl, accountUrl },
    now,
  };
}
