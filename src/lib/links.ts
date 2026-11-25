// Signed links for the email: one click marks an item done or wrong, downloads notes or deletes data.
// Token = base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload part, LINK_SIGNING_SECRET)).
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { env } from "@/lib/env";

export type ItemAction = "done" | "wrong" | "undo";
export type AccountAction = "download" | "delete";
export type LinkAction = ItemAction | AccountAction;

export interface LinkPayload {
  /** User id. */
  u: string;
  /** Item id, for item actions only. */
  i?: string;
  a: LinkAction;
  /** Expiry, seconds since the epoch. */
  exp: number;
}

export const LINK_TTL_SECONDS = 30 * 24 * 60 * 60;

const ITEM_ACTIONS: readonly string[] = ["done", "wrong", "undo"];

const payloadSchema = z
  .object({
    u: z.string().min(1).max(64),
    i: z.string().min(1).max(64).optional(),
    a: z.enum(["done", "wrong", "undo", "download", "delete"]),
    exp: z.number().int().positive(),
  })
  .strict()
  .refine((p) => (ITEM_ACTIONS.includes(p.a) ? p.i !== undefined : p.i === undefined));

function sign(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

function appBase(): string {
  return env.appUrl.replace(/\/+$/, "");
}

export function signToken(payload: LinkPayload, secret: string = env.linkSecret): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${sign(body, secret)}`;
}

function expiry(now: number): number {
  return Math.floor(now / 1000) + LINK_TTL_SECONDS;
}

export function actionUrl(userId: string, itemId: string, action: ItemAction, now: number = Date.now()): string {
  return `${appBase()}/a/${signToken({ u: userId, i: itemId, a: action, exp: expiry(now) })}`;
}

export function accountUrl(userId: string, action: AccountAction, now: number = Date.now()): string {
  return `${appBase()}/a/${signToken({ u: userId, a: action, exp: expiry(now) })}`;
}

/** Returns the payload when the signature is valid and the link has not expired, else null. */
export function verifyToken(token: string, now: number = Date.now(), secret: string = env.linkSecret): LinkPayload | null {
  if (typeof token !== "string" || token.length > 2048) return null;
  const m = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(token);
  if (!m) return null;
  const [, body, sig] = m;
  const expected = Buffer.from(sign(body, secret), "base64url");
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const parsed = payloadSchema.safeParse(raw);
  if (!parsed.success) return null;
  if (parsed.data.exp * 1000 <= now) return null;
  return parsed.data;
}
