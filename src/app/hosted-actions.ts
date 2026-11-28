"use server";
// Server actions for hosted-only pages: sign-in, account, billing and teams. Each one refuses to
// run in local mode, and each works only on the signed-in user (never an id from the form).
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { isHosted } from "@/server/mode";
import { rootStore, sessionUserId, userStore } from "@/server/hosted/app";
import { NEXT_COOKIE, PKCE_COOKIE, REF_COOKIE, safeNext, sendMagicLink } from "@/server/hosted/auth";
import { Razorpay, redeemReferral, startSubscription } from "@/server/hosted/billing";
import { hostedConfig } from "@/server/hosted/config";
import { isSlackWebhook } from "@/server/hosted/deliver";
import { SESSION_COOKIE } from "@/server/hosted/session";
import * as teams from "@/server/hosted/teams";

function hostedOnly(): void {
  if (!isHosted()) throw new Error("hosted mode only");
}

async function signedIn(): Promise<string> {
  hostedOnly();
  const uid = await sessionUserId();
  if (!uid) redirect("/login");
  return uid;
}

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const secure = () => hostedConfig().appUrl.startsWith("https://");

// ---------- sign-in ----------

export async function sendSignInLink(form: FormData): Promise<void> {
  hostedOnly();
  const cfg = hostedConfig();
  const r = await sendMagicLink(str(form, "email"), cfg);
  if (!r.ok) redirect(`/login?error=${r.error}`);
  const jar = await cookies();
  const opts = { httpOnly: true, secure: secure(), sameSite: "lax" as const, path: "/auth", maxAge: 60 * 60 };
  jar.set(PKCE_COOKIE, r.verifier, opts);
  jar.set(NEXT_COOKIE, safeNext(str(form, "next")), opts);
  const ref = str(form, "ref").toUpperCase();
  if (/^[0-9A-Z]{4,16}$/.test(ref)) jar.set(REF_COOKIE, ref, opts);
  redirect("/login?sent=1");
}

export async function signOut(): Promise<void> {
  hostedOnly();
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}

// ---------- account ----------

export async function saveDelivery(form: FormData): Promise<void> {
  const uid = await signedIn();
  const slack = str(form, "slack");
  if (slack && !isSlackWebhook(slack)) redirect("/account?error=slack");
  const email = form.get("email") === "on";
  if (!email && !slack) redirect("/account?error=none");
  await (await userStore()).setDelivery(uid, { email, slackWebhook: slack || null });
  redirect("/account?saved=1");
}

/** Deletes everything we hold for you, and your sign-in account when the service key is set. */
export async function deleteAccount(form: FormData): Promise<void> {
  const uid = await signedIn();
  if (str(form, "confirm") !== "DELETE") redirect("/account?error=confirm");
  await (await userStore()).deleteUser(uid);
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const cfg = hostedConfig();
  if (key) {
    await fetch(`${cfg.supabaseUrl}/auth/v1/admin/users/${uid}`, { method: "DELETE", headers: { apikey: key, authorization: `Bearer ${key}` } })
      .catch(() => undefined);
  }
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login?deleted=1");
}

// ---------- billing ----------

export async function subscribe(): Promise<void> {
  const uid = await signedIn();
  const cfg = hostedConfig().billing;
  let url: string | null = null;
  try {
    url = (await startSubscription(rootStore().db, uid, cfg, new Razorpay(cfg))).url;
  } catch (e) {
    console.error(`[billing] subscribe failed: ${e instanceof Error ? e.name : "Error"}`);
    redirect("/billing?error=subscribe");
  }
  redirect(url ?? "/billing");
}

export async function redeemCode(form: FormData): Promise<void> {
  const uid = await signedIn();
  const r = await redeemReferral(rootStore().db, uid, str(form, "code"), hostedConfig().billing, new Date());
  redirect(`/billing?redeem=${r}`);
}

// ---------- teams ----------

function teamsOn(): void {
  if (!hostedConfig().teamsEnabled) throw new Error("teams are off");
}

async function teamAction(ws: string, fn: (uid: string, db: ReturnType<typeof rootStore>["db"]) => Promise<unknown>): Promise<void> {
  const uid = await signedIn();
  teamsOn();
  let error: string | null = null;
  try {
    await fn(uid, rootStore().db);
  } catch (e) {
    if (!(e instanceof teams.TeamError)) throw e;
    error = e.code;
  }
  revalidatePath("/team");
  redirect(`/team?ws=${encodeURIComponent(ws)}${error ? `&error=${error}` : ""}`);
}

export async function createTeam(form: FormData): Promise<void> {
  const uid = await signedIn();
  teamsOn();
  let id: string;
  try {
    id = await teams.createWorkspace(rootStore().db, uid, str(form, "name"));
  } catch {
    redirect("/team?error=invalid");
  }
  redirect(`/team?ws=${id}`);
}

export async function inviteMember(form: FormData) {
  const ws = str(form, "ws");
  await teamAction(ws, (uid, db) => teams.invite(db, uid, ws, str(form, "email"), str(form, "role") === "admin" ? "admin" : "member"));
}

export async function changeRole(form: FormData) {
  const ws = str(form, "ws");
  const role = str(form, "role") as teams.Role;
  await teamAction(ws, (uid, db) => teams.setRole(db, uid, ws, str(form, "user"), role));
}

export async function removeFromTeam(form: FormData) {
  const ws = str(form, "ws");
  await teamAction(ws, (uid, db) => teams.removeMember(db, uid, ws, str(form, "user")));
}

export async function leaveTeam(form: FormData) {
  const ws = str(form, "ws");
  const uid = await signedIn();
  teamsOn();
  try { await teams.removeMember(rootStore().db, uid, ws, uid); } catch (e) {
    if (e instanceof teams.TeamError) redirect(`/team?ws=${encodeURIComponent(ws)}&error=${e.code}`);
    throw e;
  }
  redirect("/team");
}

export async function toggleManagerBrief(form: FormData) {
  const ws = str(form, "ws");
  await teamAction(ws, (uid, db) => teams.setManagerBrief(db, uid, ws, form.get("on") === "1"));
}

export async function toggleShareWithManager(form: FormData) {
  const ws = str(form, "ws");
  await teamAction(ws, (uid, db) => teams.setShareWithManager(db, uid, ws, form.get("on") === "1"));
}

/** Share or unshare one of your items with a team, from the item's page. */
export async function setItemShared(form: FormData): Promise<void> {
  const uid = await signedIn();
  teamsOn();
  const ws = str(form, "ws"), item = str(form, "item");
  try {
    if (form.get("on") === "1") await teams.shareItem(rootStore().db, uid, ws, item);
    else await teams.unshareItem(rootStore().db, uid, ws, item);
  } catch (e) {
    if (!(e instanceof teams.TeamError)) throw e;
  }
  revalidatePath(`/item/${item}`);
  redirect(`/item/${encodeURIComponent(item)}`);
}
