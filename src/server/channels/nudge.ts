import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ChannelsFile } from "./config";
import { ChannelError, type Fetch } from "./http";
import { slackApi } from "./senders";

// Sending a nudge draft as a Slack DM. Nothing here runs by itself: the page asks for a confirmation
// (prepareNudge), shows the recipient and the exact text in a dialog, and only the signed answer to
// that dialog (sendNudge) sends. A confirmation works once and for ten minutes.

export const CONFIRM_TTL_MS = 10 * 60_000;

export interface SlackMember {
  id: string;
  name: string;
  /** "@tarun · tarun@x.com" */
  detail: string;
}

/** Slack can send nudges when a bot or user token is saved and Slack is in bot mode. */
export function nudgesReady(file: Pick<ChannelsFile, "slack" | "secretsSet">): boolean {
  return file.slack.mode === "bot" && (file.secretsSet.includes("slackUser") || file.secretsSet.includes("slackBot"));
}

/** The text that is sent: as you with a user token, or from the app with your name in front. */
export function nudgeText(draft: string, asUser: boolean, yourName: string): string {
  return asUser || !yourName.trim() ? draft : `From ${yourName.trim()}: ${draft}`;
}

interface RawMember {
  id?: string;
  name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  real_name?: string;
  profile?: { real_name?: string; display_name?: string; email?: string };
}

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N} ]/gu, "").trim();

function toMember(m: RawMember): SlackMember {
  const name = m.profile?.real_name || m.real_name || m.profile?.display_name || m.name || "Someone";
  const handle = m.profile?.display_name || m.name;
  return { id: String(m.id), name, detail: [handle ? `@${handle}` : "", m.profile?.email ?? ""].filter(Boolean).join(" · ") };
}

/** Workspace members whose name matches the person: full name first, then first name. At most 5. */
export function matchMembers(members: RawMember[], person: string): SlackMember[] {
  const want = norm(person);
  const first = want.split(/\s+/)[0] ?? "";
  if (!first) return [];
  const live = members.filter((m) => m.id && !m.deleted && !m.is_bot && m.id !== "USLACKBOT");
  const score = (m: RawMember) => {
    const names = [m.profile?.real_name, m.real_name, m.profile?.display_name, m.name].filter(Boolean).map((n) => norm(n!));
    if (names.some((n) => n === want)) return 3;
    if (names.some((n) => n.startsWith(`${want} `) || n.split(/[ .]/)[0] === first)) return 2;
    if (names.some((n) => n.split(/\s+/).includes(first))) return 1;
    return 0;
  };
  return live
    .map((m) => [score(m), m] as const)
    .filter(([s]) => s > 0)
    .sort((a, b) => b[0] - a[0])
    .slice(0, 5)
    .map(([, m]) => toMember(m));
}

/** users.list, a few pages (needs users:read; users:read.email for addresses). */
export async function findMembers(fetchFn: Fetch, token: string, person: string): Promise<SlackMember[]> {
  const all: RawMember[] = [];
  let cursor = "";
  for (let page = 0; page < 5; page++) {
    const r = await slackApi(fetchFn, token, "users.list", { limit: 200, ...(cursor ? { cursor } : {}) });
    all.push(...((r.members as RawMember[] | undefined) ?? []));
    cursor = String((r.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? "");
    if (!cursor) break;
  }
  return matchMembers(all, person);
}

export async function findMemberByEmail(fetchFn: Fetch, token: string, email: string): Promise<SlackMember | null> {
  try {
    const r = await slackApi(fetchFn, token, "users.lookupByEmail", { email });
    const u = r.user as RawMember | undefined;
    return u?.id && !u.deleted && !u.is_bot ? toMember(u) : null;
  } catch (e) {
    if (e instanceof ChannelError && /users_not_found/.test(e.message)) return null;
    throw e;
  }
}

/** Open (or find) the DM with the member and post the text. Returns the message ts. */
export async function postDm(fetchFn: Fetch, token: string, memberId: string, text: string): Promise<string> {
  const open = await slackApi(fetchFn, token, "conversations.open", { users: memberId });
  const channel = (open.channel as { id?: string } | undefined)?.id;
  if (!channel) throw new ChannelError("Slack didn't open the DM");
  const r = await slackApi(fetchFn, token, "chat.postMessage", { channel, text, unfurl_links: false });
  return String(r.ts ?? "");
}

// ---- confirmations ----

const g = globalThis as unknown as { __dbNudgeKey?: Buffer; __dbNudgeUsed?: Map<string, number> };
const key = () => (g.__dbNudgeKey ??= randomBytes(32));
const used = () => (g.__dbNudgeUsed ??= new Map());

const hash = (s: string) => createHash("sha256").update(s).digest("base64url");

export interface Confirm {
  exp: number;
  sig: string;
}

function mac(itemId: string, memberId: string, text: string, exp: number): string {
  return createHmac("sha256", key()).update(`${itemId}\n${memberId}\n${hash(text)}\n${exp}`).digest("base64url");
}

/** Sign what the dialog shows: this item, this recipient, this exact text. */
export function signConfirm(itemId: string, memberId: string, text: string, now: number): Confirm {
  const exp = now + CONFIRM_TTL_MS;
  return { exp, sig: mac(itemId, memberId, text, exp) };
}

/** True once for a fresh, matching confirmation. A second use, a different text or recipient: false. */
export function spendConfirm(itemId: string, memberId: string, text: string, c: Confirm, now: number): boolean {
  if (!Number.isFinite(c.exp) || c.exp < now || c.exp > now + CONFIRM_TTL_MS) return false;
  const want = Buffer.from(mac(itemId, memberId, text, c.exp));
  const got = Buffer.from(String(c.sig));
  if (want.length !== got.length || !timingSafeEqual(want, got)) return false;
  const u = used();
  for (const [s, exp] of u) if (exp < now) u.delete(s);
  if (u.has(c.sig)) return false;
  u.set(c.sig, c.exp);
  return true;
}
