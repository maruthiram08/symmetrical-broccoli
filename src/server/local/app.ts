import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "@/lib/env";
import { buildBrief } from "@/lib/brief/build";
import type { User } from "@/lib/types";
import type { Deps } from "@/server/jobs/types";
import { McpWisprClient } from "@/server/wispr/client";
import type { WisprAuthContext } from "@/server/wispr/oauth";
import { FileStore } from "./file-store";
import { appUrl, dataDir, notesDir } from "./paths";
import { publishLocal } from "./publish";
import { withTomorrow } from "./calendar";
import type { AppStore } from "@/server/app-store";
import { isHosted } from "@/server/mode";
import { hostedMe, hostedSaveMe, hostedWisprAuthContext, sessionDeps, sessionStore } from "@/server/hosted/app";
import { extractWithPrefs, extractionCostInr } from "./extract-local";
import { resolveTask } from "@/server/ai-config";
import { afterPublish, renderDailyFor, renderDecisionsFor, renderWeekFor } from "./outputs";
import { currentWorkspace, homeDataDir } from "./workspaces";
import { publishChannels } from "@/server/channels/local";

/**
 * A random key kept next to the data, used to seal the short-lived OAuth state cookie and the
 * Wispr Flow tokens. One key for every workspace: it lives in the home folder's .daily-brief/.
 */
function ensureLocalKey(): void {
  if (process.env.TOKEN_ENCRYPTION_KEY) return;
  const dir = homeDataDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = join(dir, "key");
  if (!existsSync(p)) writeFileSync(p, randomBytes(32).toString("base64"), { mode: 0o600 });
  process.env.TOKEN_ENCRYPTION_KEY = readFileSync(p, "utf8").trim();
}

const g = globalThis as unknown as { __dbStores?: Map<string, FileStore> };

/**
 * The current workspace's file store (local mode, and the local scheduler and tools): one per workspace per process (Next dev reloads modules;
 * globalThis survives). Each workspace has its own state.json and Wispr Flow connection.
 */
export function getFileStore(): FileStore {
  const path = join(dataDir(), "state.json");
  const all = (g.__dbStores ??= new Map());
  let s = all.get(path);
  if (!s) {
    ensureLocalKey();
    all.set(path, (s = new FileStore(path)));
  }
  return s;
}

/**
 * The app's store. Local: the current workspace's file store.
 * Hosted (DAILY_BRIEF_MODE=hosted): the signed-in user's rows in Supabase.
 */
export function getStore(): AppStore {
  return isHosted() ? sessionStore() : getFileStore();
}

/** The local app has exactly one user: you. Null until setup is saved. */
export async function me(): Promise<User | null> {
  if (isHosted()) return hostedMe();
  return (await getStore().listUsers())[0] ?? null;
}

export async function saveMe(s: Pick<User, "name" | "aliases" | "timeZone" | "briefTime">): Promise<User> {
  if (isHosted()) return hostedSaveMe(s);
  const store = getFileStore();
  const u = await me();
  if (u) return (await store.updateUser(u.id, s))!;
  return store.addUser({ email: "you@this-mac", ...s });
}

export function wisprAuthContext(userId: string, now: () => Date = () => new Date()): WisprAuthContext {
  if (isHosted()) return hostedWisprAuthContext(userId, sessionStore(), now);
  const s = getFileStore();
  return { userId, store: s, clients: s, appUrl: appUrl(), serverUrl: env.wisprMcpUrl, now };
}

/** Jobs for the current workspace. Captured now, so a switch mid-run can't send them elsewhere. */
export function buildDeps(): Deps {
  if (isHosted()) return sessionDeps();
  const now = () => new Date();
  const ws = currentWorkspace();
  const dir = notesDir();
  const store = getFileStore();
  return {
    store,
    wispr: (userId) => new McpWisprClient(wisprAuthContext(userId, now)),
    // Claude by default; Settings can switch reading to a local Ollama model.
    extract: (input) => extractWithPrefs(input),
    costInr: extractionCostInr,
    model: resolveTask("extraction").qualified,
    buildBrief: async (store, user, at) => withTomorrow(store, user, at, await buildBrief(store, user, at)),
    renderMarkdown: (model) => renderDailyFor(ws, store, model),
    renderWeek: (user, week) => renderWeekFor(ws, store, user, week),
    publish: async (user, model, markdown, week) => {
      const decisions = await renderDecisionsFor(ws, store, model);
      const r = await publishLocal(dir, user, model, markdown, undefined, week, decisions);
      await afterPublish(ws, store, user, model, week);
      await publishChannels(store, user, model, { recap: !!week }); // email, Slack, Telegram, WhatsApp; never throws
      return r;
    },
    now,
  };
}
