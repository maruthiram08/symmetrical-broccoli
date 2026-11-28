// Wires the integrations to the running app: the real store, vault and fetch, and a one-minute loop
// (webhooks; the ticket check inside it waits 30 minutes between runs). Only the process that holds
// the scheduler lock runs the loop, so two copies of the app never both send.
import { getFileStore } from "@/server/local/app";
import { errLine } from "@/server/local/log";
import { appUrl } from "@/server/local/paths";
import { listWorkspaces, withWorkspace } from "@/server/local/workspaces";
import type { ApiDeps } from "./api";
import { getIntegrations } from "./config";
import { syncTickets, type TicketDeps } from "./tickets";
import { getVault } from "./vault";
import { runWebhooks, type WebhookDeps } from "./webhooks";

export const LOOP_MS = 60_000;

export function liveDeps(): TicketDeps & WebhookDeps & ApiDeps {
  const deps: TicketDeps & WebhookDeps & ApiDeps = {
    store: getFileStore(),
    integrations: getIntegrations(),
    vault: getVault(),
    fetch: (url, init) => fetch(url, init),
    appUrl: appUrl(),
    now: () => new Date(),
  };
  deps.afterWrite = () => runWebhooksSafely(deps);
  return deps;
}

async function runWebhooksSafely(deps: WebhookDeps): Promise<void> {
  try {
    await runWebhooks(deps);
  } catch (e) {
    console.error(`[webhooks] ${errLine(e, { message: false })}`);
  }
}

/** One pass: closed tickets close their items (every 30 min at most), then webhooks. */
export async function integrationsTick(deps = liveDeps()): Promise<void> {
  try {
    await syncTickets(deps);
  } catch (e) {
    console.error(`[tickets] ${errLine(e, { message: false })}`);
  }
  await runWebhooksSafely(deps);
}

const g = globalThis as unknown as { __dbIntegrationsLoop?: NodeJS.Timeout; __dbIntegrationsBusy?: boolean };

/** Started by the scheduler. `isOwner` says whether this process holds the scheduler lock. */
export function startIntegrations(isOwner: () => boolean): void {
  if (g.__dbIntegrationsLoop) return;
  g.__dbIntegrationsLoop = setInterval(() => {
    if (g.__dbIntegrationsBusy || !isOwner()) return;
    g.__dbIntegrationsBusy = true;
    // Every workspace in turn, each with its own integrations and items.
    void (async () => {
      for (const ws of listWorkspaces()) {
        try { await withWorkspace(ws, () => integrationsTick()); } catch (e) { console.error(`[integrations] workspace ${ws.id}: ${errLine(e)}`); }
      }
    })().finally(() => { g.__dbIntegrationsBusy = false; });
  }, LOOP_MS);
  g.__dbIntegrationsLoop.unref?.();
}
