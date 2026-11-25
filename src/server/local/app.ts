import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "@/lib/env";
import { buildBrief } from "@/lib/brief/build";
import { renderMarkdown } from "@/lib/brief/markdown";
import { extractMeeting } from "@/lib/extract/extract";
import { costInr } from "@/lib/extract/cost";
import type { User } from "@/lib/types";
import type { Deps } from "@/server/jobs/types";
import { McpWisprClient } from "@/server/wispr/client";
import type { WisprAuthContext } from "@/server/wispr/oauth";
import { FileStore } from "./file-store";
import { appUrl, dataDir, notesDir } from "./paths";
import { publishLocal } from "./publish";

/** A random key kept next to the data, used to seal the short-lived OAuth state cookie. */
function ensureLocalKey(): void {
  if (process.env.TOKEN_ENCRYPTION_KEY) return;
  const dir = dataDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = join(dir, "key");
  if (!existsSync(p)) writeFileSync(p, randomBytes(32).toString("base64"), { mode: 0o600 });
  process.env.TOKEN_ENCRYPTION_KEY = readFileSync(p, "utf8").trim();
}

const g = globalThis as unknown as { __dbStore?: FileStore };

/** One store per process (Next dev reloads modules; globalThis survives). */
export function getStore(): FileStore {
  if (!g.__dbStore) {
    ensureLocalKey();
    g.__dbStore = new FileStore(join(dataDir(), "state.json"));
  }
  return g.__dbStore;
}

/** The local app has exactly one user: you. Null until setup is saved. */
export async function me(): Promise<User | null> {
  return (await getStore().listUsers())[0] ?? null;
}

export async function saveMe(s: Pick<User, "name" | "aliases" | "timeZone" | "briefTime">): Promise<User> {
  const store = getStore();
  const u = await me();
  if (u) return (await store.updateUser(u.id, s))!;
  return store.addUser({ email: "you@this-mac", ...s });
}

export function wisprAuthContext(userId: string, now: () => Date = () => new Date()): WisprAuthContext {
  const s = getStore();
  return { userId, store: s, clients: s, appUrl: appUrl(), serverUrl: env.wisprMcpUrl, now };
}

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
    publish: (user, model, markdown) => publishLocal(notesDir(), user, model, markdown),
    now,
  };
}
