import { randomBytes } from "node:crypto";
import {
  auth,
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  refreshAuthorization,
  selectResourceURL,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthProtectedResourceMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  AccessDeniedError,
  InvalidClientError,
  InvalidGrantError,
  InvalidTokenError,
  UnauthorizedClientError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Connection } from "@/lib/types";
import type { Store } from "@/server/store";
import { decrypt, encrypt } from "@/server/crypto";
import { isNetworkError } from "@/lib/extract/errors";

/**
 * Where the dynamic-client-registration result lives. The Store interface has no slot for it
 * (shared change requested: Connection.oauthClient or Store.get/saveOAuthClient), so it is a
 * separate interface. SupabaseStore implements it on connections.oauth_client.
 */
export interface OAuthClientStore {
  getOAuthClient(userId: string): Promise<OAuthClientInformationMixed | null>;
  saveOAuthClient(userId: string, info: OAuthClientInformationMixed): Promise<void>;
}

export class MemoryOAuthClientStore implements OAuthClientStore {
  clients = new Map<string, OAuthClientInformationMixed>();
  async getOAuthClient(userId: string) { return this.clients.get(userId) ?? null; }
  async saveOAuthClient(userId: string, info: OAuthClientInformationMixed) { this.clients.set(userId, info); }
}

/** The connection can't be used until the user signs in to Wispr Flow again. */
export class ReconnectRequiredError extends Error {
  constructor(message = "Wispr Flow connection needs reconnect") {
    super(message);
    this.name = "ReconnectRequiredError";
  }
}

export const PENDING_COOKIE = "db_wispr_oauth";
const PENDING_TTL_MS = 10 * 60 * 1000;
const DEFAULT_TOKEN_TTL_SEC = 3600;
/** Refreshes in a row that Wispr Flow rejects with an unrecognised error before we ask to reconnect. */
export const MAX_REFRESH_FAILURES = 4;

/** Short-lived state between /connect and /callback. Sealed with AES-GCM into an httpOnly cookie. */
export interface PendingAuth {
  userId: string;
  state: string;
  codeVerifier?: string;
  clientInformation?: OAuthClientInformationMixed;
  exp: number; // epoch ms
}

export function sealPending(p: PendingAuth, keyB64?: string): string {
  return encrypt(JSON.stringify(p), keyB64);
}

export function openPending(sealed: string | undefined, now: Date, keyB64?: string): PendingAuth | null {
  if (!sealed) return null;
  try {
    const p = JSON.parse(decrypt(sealed, keyB64)) as PendingAuth;
    if (typeof p.userId !== "string" || typeof p.state !== "string" || typeof p.exp !== "number") return null;
    if (p.exp < now.getTime()) return null;
    return p;
  } catch {
    return null;
  }
}

export function expiresAtFrom(t: Pick<OAuthTokens, "expires_in">, now: Date): string {
  const sec = typeof t.expires_in === "number" && t.expires_in > 0 ? t.expires_in : DEFAULT_TOKEN_TTL_SEC;
  return new Date(now.getTime() + sec * 1000).toISOString();
}

export async function markNeedsReconnect(store: Store, userId: string, reason: string): Promise<void> {
  const conn = await store.getConnection(userId);
  if (conn?.status === "needs_reconnect") return; // already asked; don't log it again on every try
  if (conn) await store.saveConnection({ ...conn, status: "needs_reconnect" });
  await store.logEvent({ userId, type: "job_error", payload: { job: "wispr_auth", reason: reason.slice(0, 200) } });
  console.error(`[wispr] user=${userId} needs to reconnect Wispr Flow (${reason.slice(0, 120)})`);
}

export interface WisprAuthContext {
  userId: string;
  store: Store;
  clients: OAuthClientStore;
  appUrl: string;
  serverUrl: string;
  now: () => Date;
  fetchFn?: FetchLike;
}

/**
 * OAuthClientProvider backed by the Store.
 *  - interactive: used by /connect and /callback. Always registers a fresh client, keeps the PKCE
 *    verifier, state and client info in `pending` (which the routes seal into a cookie), and
 *    captures the authorization URL instead of redirecting.
 *  - background: used by jobs. Reads tokens and client info from the store. If the SDK decides a
 *    user redirect is needed (refresh failed), marks the connection needs_reconnect and throws.
 */
export class WisprOAuthProvider implements OAuthClientProvider {
  authorizationUrl: URL | undefined;

  constructor(
    private ctx: WisprAuthContext,
    private mode: "interactive" | "background",
    public pending?: PendingAuth,
  ) {}

  get redirectUrl(): string {
    return `${this.ctx.appUrl.replace(/\/$/, "")}/api/wispr/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Daily brief",
      client_uri: this.ctx.appUrl,
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      // OPEN QUESTION (day 2): does Wispr Flow's registration endpoint accept public clients
      // ("none") or issue a secret? The SDK handles either once registered.
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    return this.pending?.state ?? randomBytes(16).toString("base64url");
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    if (this.mode === "interactive") return this.pending?.clientInformation;
    return (await this.ctx.clients.getOAuthClient(this.ctx.userId)) ?? undefined;
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    if (this.mode === "interactive") {
      if (!this.pending) throw new Error("interactive provider needs pending state");
      this.pending.clientInformation = info;
      return;
    }
    await this.ctx.clients.saveOAuthClient(this.ctx.userId, info);
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    if (this.mode === "interactive") return undefined; // connect always starts a fresh grant
    const c = await this.ctx.store.getConnection(this.ctx.userId);
    if (!c || c.status === "needs_reconnect") return undefined;
    const expiresIn = Math.max(0, Math.floor((Date.parse(c.expiresAt) - this.ctx.now().getTime()) / 1000));
    return { access_token: c.accessToken, refresh_token: c.refreshToken || undefined, token_type: "Bearer", expires_in: expiresIn };
  }

  async saveTokens(t: OAuthTokens): Promise<void> {
    const existing = await this.ctx.store.getConnection(this.ctx.userId);
    const conn: Connection = {
      userId: this.ctx.userId,
      provider: "wispr_flow",
      accessToken: t.access_token,
      refreshToken: t.refresh_token ?? existing?.refreshToken ?? "",
      expiresAt: expiresAtFrom(t, this.ctx.now()),
      lastSeenAt: existing?.lastSeenAt ?? null,
      status: "active",
    };
    await this.ctx.store.saveConnection(conn);
    // The connections row now exists, so the registration can be stored next to it.
    if (this.mode === "interactive" && this.pending?.clientInformation) {
      await this.ctx.clients.saveOAuthClient(this.ctx.userId, this.pending.clientInformation);
    }
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    if (this.mode === "interactive") {
      this.authorizationUrl = url;
      return;
    }
    await markNeedsReconnect(this.ctx.store, this.ctx.userId, "authorization required (refresh failed or token rejected)");
    throw new ReconnectRequiredError();
  }

  saveCodeVerifier(v: string): void {
    if (!this.pending) throw new ReconnectRequiredError("no pending authorization");
    this.pending.codeVerifier = v;
  }

  codeVerifier(): string {
    if (!this.pending?.codeVerifier) throw new ReconnectRequiredError("no PKCE verifier");
    return this.pending.codeVerifier;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier"): Promise<void> {
    if (this.mode === "interactive" && this.pending) {
      if (scope === "all" || scope === "client") this.pending.clientInformation = undefined;
      if (scope === "all" || scope === "verifier") this.pending.codeVerifier = undefined;
    }
    // background: the following redirectToAuthorization marks needs_reconnect.
  }
}

/** Step 1 (/api/wispr/connect): discover, register, build the authorization URL. */
export async function startWisprAuth(ctx: WisprAuthContext): Promise<{ authorizationUrl: URL; pending: PendingAuth }> {
  const pending: PendingAuth = {
    userId: ctx.userId,
    state: randomBytes(24).toString("base64url"),
    exp: ctx.now().getTime() + PENDING_TTL_MS,
  };
  const provider = new WisprOAuthProvider(ctx, "interactive", pending);
  const result = await auth(provider, { serverUrl: ctx.serverUrl, fetchFn: ctx.fetchFn });
  if (result !== "REDIRECT" || !provider.authorizationUrl) throw new Error("Wispr Flow did not return an authorization URL");
  return { authorizationUrl: provider.authorizationUrl, pending };
}

/** Step 2 (/api/wispr/callback): check state, exchange the code, save the connection. */
export async function finishWisprAuth(
  ctx: WisprAuthContext,
  args: { pending: PendingAuth | null; code: string; state: string },
): Promise<void> {
  const p = args.pending;
  if (!p) throw new Error("Authorization expired or cookie missing");
  if (p.state !== args.state) throw new Error("OAuth state mismatch");
  if (p.userId !== ctx.userId) throw new Error("OAuth user mismatch");
  const provider = new WisprOAuthProvider(ctx, "interactive", { ...p });
  const result = await auth(provider, { serverUrl: ctx.serverUrl, authorizationCode: args.code, fetchFn: ctx.fetchFn });
  if (result !== "AUTHORIZED") throw new Error("Wispr Flow authorization did not complete");
}

export type RefreshFn = (a: {
  ctx: WisprAuthContext;
  clientInformation: OAuthClientInformationMixed;
  refreshToken: string;
}) => Promise<OAuthTokens>;

/** Refresh via the SDK: discover the authorization server the same way `auth()` does, then refresh. */
export const sdkRefresh: RefreshFn = async ({ ctx, clientInformation, refreshToken }) => {
  let resourceMetadata: OAuthProtectedResourceMetadata | undefined;
  let authServer: string | URL = new URL("/", ctx.serverUrl);
  try {
    resourceMetadata = await discoverOAuthProtectedResourceMetadata(ctx.serverUrl, {}, ctx.fetchFn);
    if (resourceMetadata.authorization_servers?.length) authServer = resourceMetadata.authorization_servers[0];
  } catch {
    // fall back to the server origin, as the SDK does
  }
  const provider = new WisprOAuthProvider(ctx, "background");
  const resource = await selectResourceURL(ctx.serverUrl, provider, resourceMetadata);
  const metadata = await discoverAuthorizationServerMetadata(authServer, { fetchFn: ctx.fetchFn });
  return refreshAuthorization(authServer, { metadata, clientInformation, refreshToken, resource, fetchFn: ctx.fetchFn });
};

/** Errors that mean the grant is gone, as opposed to a network blip or 5xx. */
export function isPermanentAuthError(e: unknown): boolean {
  return (
    e instanceof InvalidGrantError ||
    e instanceof InvalidClientError ||
    e instanceof UnauthorizedClientError ||
    e instanceof InvalidTokenError ||
    e instanceof AccessDeniedError ||
    e instanceof ReconnectRequiredError
  );
}

/**
 * Returns a valid access token, refreshing it first when it expires within `skewSec`.
 * A permanent refresh failure marks the connection needs_reconnect and throws ReconnectRequiredError;
 * a transient failure throws as-is and leaves the connection active.
 */
export async function ensureFreshAccessToken(
  ctx: WisprAuthContext,
  opts: { skewSec?: number; refresh?: RefreshFn } = {},
): Promise<string> {
  const conn = await ctx.store.getConnection(ctx.userId);
  if (!conn) throw new ReconnectRequiredError("no Wispr Flow connection");
  if (conn.status === "needs_reconnect") throw new ReconnectRequiredError();
  const now = ctx.now();
  if (Date.parse(conn.expiresAt) - (opts.skewSec ?? 60) * 1000 > now.getTime()) return conn.accessToken;

  const clientInformation = await ctx.clients.getOAuthClient(ctx.userId);
  if (!conn.refreshToken || !clientInformation) {
    await markNeedsReconnect(ctx.store, ctx.userId, !conn.refreshToken ? "no refresh token" : "no client registration");
    throw new ReconnectRequiredError();
  }
  let tokens: OAuthTokens;
  try {
    tokens = await (opts.refresh ?? sdkRefresh)({ ctx, clientInformation, refreshToken: conn.refreshToken });
  } catch (e) {
    if (isPermanentAuthError(e)) {
      await markNeedsReconnect(ctx.store, ctx.userId, `refresh failed: ${(e as Error).name}`);
      throw new ReconnectRequiredError();
    }
    // Offline: try again next time, nothing is wrong with the grant.
    if (isNetworkError(e)) throw e;
    // Wispr Flow answered, but with an error we can't place (5xx, odd OAuth error). A few in a row
    // and the sign-in is treated as gone, so the app asks to reconnect instead of retrying forever.
    const failures = (conn.refreshFailures ?? 0) + 1;
    const latest = (await ctx.store.getConnection(ctx.userId)) ?? conn;
    await ctx.store.saveConnection({ ...latest, refreshFailures: failures });
    if (failures >= MAX_REFRESH_FAILURES) {
      await markNeedsReconnect(ctx.store, ctx.userId, `refresh failed ${failures} times: ${(e as Error)?.name ?? "Error"}`);
      throw new ReconnectRequiredError();
    }
    throw e;
  }
  const latest = (await ctx.store.getConnection(ctx.userId)) ?? conn;
  await ctx.store.saveConnection({
    ...latest,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? conn.refreshToken,
    expiresAt: expiresAtFrom(tokens, ctx.now()),
    status: "active",
    refreshFailures: 0,
  });
  return tokens.access_token;
}
