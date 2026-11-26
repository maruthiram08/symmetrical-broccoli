// Non-secret integration settings and bookkeeping, in <data>/integrations.json (0600), so the main
// state.json format doesn't change. Tokens are not here: they are in the vault (vault.ts).
// Same pattern as AiStore: reload when the file changed on disk, write atomically after every change.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TicketProvider } from "@/lib/types";
import { dataDir } from "@/server/local/paths";

export interface JiraConfig {
  enabled: boolean;
  /** https://your-team.atlassian.net */
  site: string;
  email: string;
  projectKey: string;
  issueType: string;
}
export interface LinearConfig {
  enabled: boolean;
  /** Team key, like ENG. */
  teamKey: string;
  /** Looked up from the key when saved. */
  teamId: string | null;
}
export interface NotionConfig {
  enabled: boolean;
  databaseId: string;
  /** The database's title property, read when saved ("Name" by default in Notion). */
  titleProperty: string | null;
  /** A people property to put the assignee in, when the database has one. */
  peopleProperty: string | null;
}
export interface TodoistConfig {
  enabled: boolean;
  /** Optional: Inbox when empty. Needed for an assignee (shared projects only). */
  projectId: string;
}

export interface ProviderConfigs {
  jira: JiraConfig;
  linear: LinearConfig;
  notion: NotionConfig;
  todoist: TodoistConfig;
}

/** Saved after "Save and test": who the token belongs to, or why it didn't work. */
export interface ProviderCheck {
  ok: boolean;
  at: string;
  /** "Connected as Maruthi R" or the error. */
  message: string;
}

export type WebhookEvent = "item.created" | "item.closed" | "decision.made";
export const WEBHOOK_EVENTS: WebhookEvent[] = ["item.created", "item.closed", "decision.made"];

export interface Delivery {
  id: string;
  url: string;
  event: WebhookEvent;
  /** The exact JSON body that gets signed and sent. */
  body: string;
  attempts: number;
  nextAt: string;
  createdAt: string;
}

export interface DeliveryLog {
  id: string;
  url: string;
  event: WebhookEvent;
  at: string;
  /** "delivered", "retrying" or "failed" (gave up). */
  outcome: "delivered" | "retrying" | "failed";
  /** HTTP status, or null for a network error. */
  status: number | null;
  attempts: number;
}

export interface WebhookConfig {
  enabled: boolean;
  urls: string[];
  events: WebhookEvent[];
}

export interface IntegrationsState {
  version: 1;
  providers: ProviderConfigs;
  checks: Partial<Record<TicketProvider, ProviderCheck>>;
  api: { allowedOrigins: string[]; createdAt: string | null };
  webhooks: WebhookConfig;
  /** Item id -> status last seen, so each change fires once. Filled on first run without firing. */
  seen: Record<string, string>;
  primed: boolean;
  outbox: Delivery[];
  recent: DeliveryLog[];
  /** Last time tickets were checked for closes (at most every 30 minutes). */
  ticketSyncAt: string | null;
}

export const empty = (): IntegrationsState => ({
  version: 1,
  providers: {
    jira: { enabled: false, site: "", email: "", projectKey: "", issueType: "Task" },
    linear: { enabled: false, teamKey: "", teamId: null },
    notion: { enabled: false, databaseId: "", titleProperty: null, peopleProperty: null },
    todoist: { enabled: false, projectId: "" },
  },
  checks: {},
  api: { allowedOrigins: [], createdAt: null },
  webhooks: { enabled: false, urls: [], events: [...WEBHOOK_EVENTS] },
  seen: {},
  primed: false,
  outbox: [],
  recent: [],
  ticketSyncAt: null,
});

const MAX_OUTBOX = 500;
const MAX_RECENT = 20;

export class IntegrationsStore {
  private s: IntegrationsState = empty();
  private mtime = 0;
  constructor(readonly path: string) { this.reload(); }

  private reload(): void {
    if (!existsSync(this.path)) return;
    const m = statSync(this.path).mtimeMs;
    if (m === this.mtime) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as Partial<IntegrationsState>;
      const base = empty();
      this.s = {
        ...base,
        ...raw,
        providers: {
          jira: { ...base.providers.jira, ...raw.providers?.jira },
          linear: { ...base.providers.linear, ...raw.providers?.linear },
          notion: { ...base.providers.notion, ...raw.providers?.notion },
          todoist: { ...base.providers.todoist, ...raw.providers?.todoist },
        },
        api: { ...base.api, ...raw.api },
        webhooks: { ...base.webhooks, ...raw.webhooks },
      };
    } catch {
      this.s = empty(); // a broken file only loses settings you can enter again; tokens are elsewhere
    }
    this.mtime = m;
  }

  private flush(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    this.s.outbox = this.s.outbox.slice(-MAX_OUTBOX);
    this.s.recent = this.s.recent.slice(-MAX_RECENT);
    writeFileSync(`${this.path}.tmp`, JSON.stringify(this.s), { mode: 0o600 });
    renameSync(`${this.path}.tmp`, this.path);
    chmodSync(this.path, 0o600);
    this.mtime = statSync(this.path).mtimeMs;
  }

  /** A copy of the current state. */
  read(): IntegrationsState {
    this.reload();
    return structuredClone(this.s);
  }

  /** Change the state and write it. `fn` gets the live state. */
  update<T>(fn: (s: IntegrationsState) => T): T {
    this.reload();
    const r = fn(this.s);
    this.flush();
    return r;
  }

  provider<P extends TicketProvider>(p: P): ProviderConfigs[P] {
    return this.read().providers[p];
  }
}

const g = globalThis as unknown as { __dbIntegrations?: IntegrationsStore; __dbIntegrationsByPath?: Map<string, IntegrationsStore> };

/** The current workspace's integrations (each workspace has its own integrations.json). */
export function getIntegrations(): IntegrationsStore {
  if (g.__dbIntegrations) return g.__dbIntegrations; // set by tests
  const path = join(dataDir(), "integrations.json");
  const all = (g.__dbIntegrationsByPath ??= new Map());
  let s = all.get(path);
  if (!s) all.set(path, (s = new IntegrationsStore(path)));
  return s;
}

/** Tests: use this store instead. */
export function setIntegrations(s: IntegrationsStore | undefined): void {
  g.__dbIntegrations = s;
}
