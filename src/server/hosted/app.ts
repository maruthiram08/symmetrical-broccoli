// Hosted mode's wiring: the signed-in user, their store, and the jobs' dependencies.
// src/server/local/app.ts hands over to these when DAILY_BRIEF_MODE=hosted, so pages, actions and
// routes keep calling getStore(), me() and buildDeps() exactly as they do on the Mac.
import { cookies } from "next/headers";
import { env } from "@/lib/env";
import { buildBrief } from "@/lib/brief/build";
import { renderMarkdown } from "@/lib/brief/markdown";
import { costInr } from "@/lib/extract/cost";
import { extractMeeting } from "@/lib/extract/extract";
import type { User } from "@/lib/types";
import type { AppStore } from "@/server/app-store";
import type { Deps } from "@/server/jobs/types";
import { withTomorrow } from "@/server/local/calendar";
import { McpWisprClient } from "@/server/wispr/client";
import type { WisprAuthContext } from "@/server/wispr/oauth";
import { getEntitlement } from "./billing";
import { hostedConfig } from "./config";
import { getDb, type Db } from "./db";
import { publishHosted } from "./deliver";
import type { Delivery } from "./store";
import { SESSION_COOKIE, verifySession } from "./session";
import { HostedStore } from "./store";
import { managerBriefLines } from "./teams";

export class NotSignedInError extends Error {
  constructor() { super("not signed in"); this.name = "NotSignedInError"; }
}

/** Unscoped: for sign-in, cron (lists users, then forUser) and the billing webhook only. */
export function rootStore(): HostedStore {
  return new HostedStore(getDb(), null);
}

/** The signed-in user's id from the session cookie, or null. */
export async function sessionUserId(): Promise<string | null> {
  try {
    return await verifySession((await cookies()).get(SESSION_COOKIE)?.value, hostedConfig().sessionSecret);
  } catch {
    return null; // outside a request
  }
}

export async function userStore(): Promise<HostedStore> {
  const uid = await sessionUserId();
  if (!uid) throw new NotSignedInError();
  return rootStore().forUser(uid);
}

/**
 * The signed-in user's store, synchronously (getStore() is synchronous). It reads the session
 * when created, inside the request, and every call then runs on a store scoped to that user,
 * so a page can never read or write anyone else's rows.
 */
export function sessionStore(): AppStore {
  const scoped = userStore();
  scoped.catch(() => undefined); // reported on first use instead
  return new Proxy({} as AppStore, {
    get(_t, prop) {
      if (prop === "path") return "Supabase (hosted)";
      if (prop === "then" || typeof prop === "symbol") return undefined;
      return async (...args: unknown[]) => {
        const s = (await scoped) as unknown as Record<string, unknown>;
        const fn = s[prop];
        if (typeof fn !== "function") throw new Error(`store has no ${String(prop)}`);
        return (fn as (...a: unknown[]) => unknown).apply(s, args);
      };
    },
  });
}

export async function hostedMe(): Promise<User | null> {
  const uid = await sessionUserId();
  return uid ? rootStore().forUser(uid).getUser(uid) : null;
}

export async function hostedSaveMe(s: Pick<User, "name" | "aliases" | "timeZone" | "briefTime">): Promise<User> {
  const store = await userStore();
  const u = await store.updateUser(store.scope!, s);
  if (!u) throw new NotSignedInError();
  return u;
}

export function hostedWisprAuthContext(userId: string, store: HostedStore | AppStore, now: () => Date = () => new Date()): WisprAuthContext {
  return { userId, store, clients: store, appUrl: hostedConfig().appUrl, serverUrl: env.wisprMcpUrl, now };
}

/** The jobs' dependencies on a store (scoped to one user, or the session proxy). */
function depsOn(store: AppStore, db: Db, delivery: (userId: string) => Promise<Delivery>): Deps {
  const cfg = hostedConfig();
  const now = () => new Date();
  return {
    store,
    wispr: (uid) => new McpWisprClient(hostedWisprAuthContext(uid, store, now)),
    extract: (input) => extractMeeting(input),
    costInr,
    model: env.extractionModel,
    buildBrief: async (s, user, at) => withTomorrow(s, user, at, await buildBrief(s, user, at)),
    renderMarkdown,
    publish: async (user, model, markdown) => {
      const team = cfg.teamsEnabled ? await managerBriefLines(db, user.id, now()).catch(() => []) : [];
      return publishHosted(user, model, markdown, {
        appUrl: cfg.appUrl, resendKey: cfg.resendKey, emailFrom: cfg.emailFrom, delivery: await delivery(user.id), team,
      });
    },
    now,
    // Free tier: meetings past this month's limit stay queued.
    allowance: async (uid) => (await getEntitlement(db, uid, cfg.billing, now())).meetingsLeft,
  };
}

/** The jobs' dependencies for one user, on a store scoped to them (cron, background work). */
export function hostedDeps(userId: string, root: HostedStore = rootStore()): Deps {
  const store = root.forUser(userId);
  return depsOn(store, store.db, (uid) => store.getDelivery(uid));
}

/** buildDeps() inside a request: the signed-in user's jobs, through the session store. */
export function sessionDeps(): Deps {
  const store = sessionStore();
  return depsOn(store, getDb(), (uid) => (store as unknown as HostedStore).getDelivery(uid));
}
