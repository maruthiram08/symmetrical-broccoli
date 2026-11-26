// Item -> ticket: "Send to Jira / Linear / Notion / Todoist", and the two-way close (a closed ticket
// closes its item, checked at most every 30 minutes and only for open items that have a ticket).
import { localDate } from "@/lib/brief/time";
import type { Item, ItemTicket, Meeting, TicketProvider, User } from "@/lib/types";
import type { MemoryStore } from "@/server/store";
import type { IntegrationsStore, ProviderConfigs } from "./config";
import { reason, type Fetch } from "./http";
import type { Provider, TicketInput } from "./provider";
import { jira } from "./providers/jira";
import { linear } from "./providers/linear";
import { notion } from "./providers/notion";
import { todoist } from "./providers/todoist";
import type { IntegrationSecret, Vault } from "./vault";

export const PROVIDERS: { [P in TicketProvider]: Provider<P> } = { jira, linear, notion, todoist };
export const PROVIDER_IDS: TicketProvider[] = ["jira", "linear", "notion", "todoist"];
export const TOKEN: Record<TicketProvider, IntegrationSecret> = {
  jira: "JIRA_API_TOKEN",
  linear: "LINEAR_API_KEY",
  notion: "NOTION_TOKEN",
  todoist: "TODOIST_TOKEN",
};

export const TICKET_SYNC_EVERY_MS = 30 * 60_000;
/** At most this many tickets are checked per run, oldest check first. */
const SYNC_MAX = 100;

export interface TicketDeps {
  store: MemoryStore;
  integrations: IntegrationsStore;
  vault: Vault;
  fetch: Fetch;
  appUrl: string;
  now: () => Date;
}

const dayLabel = (iso: string, timeZone: string) =>
  new Date(iso).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone });

/** Everything a ticket says about an item: title, quote, meeting, date, a link back, who to assign. */
export function ticketInput(item: Item, meeting: Meeting | null, user: Pick<User, "name" | "timeZone">, appUrl: string): TicketInput {
  const tz = user.timeZone;
  const manual = item.source === "manual";
  return {
    title: item.text,
    quote: item.quote || item.note || "",
    speaker: !item.quote ? null : item.kind === "owe" ? user.name || null : item.kind === "waiting" ? item.person : null,
    meetingTitle: manual ? null : meeting?.title ?? null,
    dateLabel: dayLabel(manual || !meeting ? item.createdAt : meeting.startedAt, tz),
    link: `${appUrl.replace(/\/+$/, "")}/item/${encodeURIComponent(item.id)}`,
    // Waiting on: they owe it, so it's theirs. You owe: it's yours.
    assigneeName: item.kind === "waiting" ? item.person : item.kind === "owe" ? user.name || null : null,
    dueDate: item.dueAt && item.kind !== "decision" ? localDate(new Date(item.dueAt), tz) : null,
  };
}

/** Providers switched on in Settings, in menu order. */
export function enabledProviders(integrations: IntegrationsStore): Array<{ id: TicketProvider; label: string }> {
  const p = integrations.read().providers;
  return PROVIDER_IDS.filter((id) => p[id].enabled).map((id) => ({ id, label: PROVIDERS[id].label }));
}

export type SendResult = { ok: true; ticket: ItemTicket; assignee: string | null } | { ok: false; error: string };

const inFlight = new Set<string>();

/** Create the ticket and store it on the item. One ticket per item; a second click returns the first. */
export async function sendToTicket(deps: TicketDeps, userId: string, itemId: string, provider: TicketProvider): Promise<SendResult> {
  const p = PROVIDERS[provider] as Provider;
  const cfg = deps.integrations.read().providers[provider];
  if (!cfg.enabled) return { ok: false, error: `${p.label} is off. Turn it on in Settings.` };
  const missing = p.incomplete(cfg as never);
  if (missing) return { ok: false, error: missing };
  const token = await deps.vault.get(TOKEN[provider]);
  if (!token) return { ok: false, error: `Add your ${p.label} token in Settings.` };
  const user = await deps.store.getUser(userId);
  const item = (await deps.store.listItems(userId)).find((i) => i.id === itemId);
  if (!user || !item) return { ok: false, error: "That item is gone." };
  if (item.ticket) return { ok: true, ticket: item.ticket, assignee: null };
  if (inFlight.has(itemId)) return { ok: false, error: "Already sending this one." };
  inFlight.add(itemId);
  try {
    const meeting = await deps.store.getMeeting(item.meetingId);
    const created = await p.create(cfg as never, token, ticketInput(item, meeting, user, deps.appUrl), deps.fetch);
    const ticket: ItemTicket = { provider, id: created.id, key: created.key, url: created.url, createdAt: deps.now().toISOString() };
    await deps.store.setItemTicket(itemId, ticket);
    await deps.store.logEvent({ userId, type: "ticket", payload: { itemId, provider, key: created.key } });
    return { ok: true, ticket, assignee: created.assignee };
  } catch (e) {
    await deps.store.logEvent({ userId, type: "job_error", payload: { job: "ticket", provider, error: reason(e) } });
    return { ok: false, error: `${p.label}: ${reason(e)}` };
  } finally {
    inFlight.delete(itemId);
  }
}

/**
 * Save a provider's settings and token, then test them. It is switched on only when the test passes;
 * the result (who you're connected as, or why not) is shown in Settings.
 */
export async function saveProvider<P extends TicketProvider>(
  deps: Pick<TicketDeps, "integrations" | "vault" | "fetch" | "now">,
  provider: P,
  settings: Partial<ProviderConfigs[P]>,
  token: string | null,
  enable: boolean,
): Promise<{ ok: boolean; message: string }> {
  const p = PROVIDERS[provider] as unknown as Provider<P>;
  if (token) {
    if (!(await deps.vault.set(TOKEN[provider], token))) return { ok: false, message: "That token has characters we can't store. Paste it again." };
  }
  const cfg = deps.integrations.update((s) => {
    s.providers[provider] = { ...s.providers[provider], ...settings, enabled: false };
    return s.providers[provider];
  });
  const at = deps.now().toISOString();
  const done = (ok: boolean, message: string, patch: Partial<ProviderConfigs[P]> = {}) => {
    deps.integrations.update((s) => {
      s.providers[provider] = { ...s.providers[provider], ...patch, enabled: ok && enable };
      s.checks[provider] = { ok, at, message };
    });
    return { ok, message };
  };
  if (!enable) return done(true, "Off");
  const missing = p.incomplete(cfg);
  if (missing) return done(false, missing);
  const saved = await deps.vault.get(TOKEN[provider]);
  if (!saved) return done(false, `Add your ${p.label} token.`);
  try {
    const r = await p.verify(cfg, saved, deps.fetch);
    return done(true, r.message, r.patch);
  } catch (e) {
    return done(false, reason(e));
  }
}

/** Forget a provider's token and switch it off. Tickets already made stay linked. */
export async function disconnectProvider(deps: Pick<TicketDeps, "integrations" | "vault">, provider: TicketProvider): Promise<void> {
  await deps.vault.remove(TOKEN[provider]);
  deps.integrations.update((s) => {
    s.providers[provider].enabled = false;
    delete s.checks[provider];
  });
}

export interface SyncResult {
  ran: boolean;
  checked: number;
  closed: string[];
  errors: number;
}

/**
 * Two-way close: for open items with a ticket in a provider that's on, ask whether the ticket is
 * closed; if so, close the item with "Closed in Linear" as the reason. Runs at most every 30
 * minutes (`force` skips the wait). Errors leave items as they are and are counted, never thrown.
 */
export async function syncTickets(deps: TicketDeps, opts: { force?: boolean; onClosed?: (item: Item) => Promise<void> } = {}): Promise<SyncResult> {
  const now = deps.now();
  const state = deps.integrations.read();
  const last = state.ticketSyncAt ? Date.parse(state.ticketSyncAt) : 0;
  if (!opts.force && now.getTime() - last < TICKET_SYNC_EVERY_MS) return { ran: false, checked: 0, closed: [], errors: 0 };
  deps.integrations.update((s) => { s.ticketSyncAt = now.toISOString(); });

  const tokens = new Map<TicketProvider, string>();
  for (const id of PROVIDER_IDS) {
    if (!state.providers[id].enabled) continue;
    const t = await deps.vault.get(TOKEN[id]);
    if (t) tokens.set(id, t);
  }
  const result: SyncResult = { ran: true, checked: 0, closed: [], errors: 0 };
  if (!tokens.size) return result;

  const users = await deps.store.listUsers();
  for (const user of users) {
    const open = (await deps.store.listItems(user.id, { status: "open" }))
      .filter((i) => i.ticket && tokens.has(i.ticket.provider))
      .sort((a, b) => (a.ticket!.createdAt ?? "").localeCompare(b.ticket!.createdAt ?? ""))
      .slice(0, SYNC_MAX);
    for (const item of open) {
      const t = item.ticket!;
      const p = PROVIDERS[t.provider] as Provider;
      result.checked++;
      try {
        const st = await p.state(state.providers[t.provider] as never, tokens.get(t.provider)!, t, deps.fetch);
        if (st !== "closed") continue;
        if (await deps.store.closeItemWithReason(item.id, `Closed in ${p.label}`, now.toISOString())) {
          result.closed.push(item.id);
          await opts.onClosed?.({ ...item, status: "done", closedAt: now.toISOString(), closeReason: `Closed in ${p.label}` });
        }
      } catch (e) {
        result.errors++;
        if (result.errors <= 3) await deps.store.logEvent({ userId: user.id, type: "job_error", payload: { job: "ticket-sync", provider: t.provider, error: reason(e) } });
      }
    }
  }
  return result;
}
