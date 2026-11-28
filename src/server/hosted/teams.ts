// Teams (v3 foundation): workspaces with members and roles, a shared decisions log, "who owes
// whom" across members, an opt-in manager brief and an audit log. Nothing a member has is
// visible to the team unless they shared that one item with the workspace (item_shares).
// Every check is here, on the server; RLS (0003_security.sql) mirrors it for the REST API.
import { randomUUID } from "node:crypto";
import { normalizeEmail } from "./auth";
import { isUuid, iso, isoOrNull, type Db } from "./db";

export type Role = "owner" | "admin" | "member";
export const ROLES: Role[] = ["owner", "admin", "member"];

export class TeamError extends Error {
  constructor(readonly code: "forbidden" | "not_found" | "invalid" | "last_owner") { super(`team: ${code}`); this.name = "TeamError"; }
}

export interface Workspace { id: string; name: string; role: Role; managerBrief: boolean; shareWithManager: boolean }
export interface Member { userId: string; email: string; name: string; aliases: string[]; role: Role; shareWithManager: boolean; joinedAt: string }

async function audit(db: Db, ws: string | null, actor: string | null, action: string, target: string | null, payload: Record<string, unknown> = {}): Promise<void> {
  await db.query("insert into audit_log (workspace_id, actor_id, action, target, payload) values ($1, $2, $3, $4, $5)", [ws, actor, action, target, JSON.stringify(payload)]);
}

export async function roleIn(db: Db, ws: string, userId: string): Promise<Role | null> {
  if (!isUuid(ws) || !isUuid(userId)) return null;
  const r = (await db.query("select role from workspace_members where workspace_id = $1 and user_id = $2", [ws, userId])).rows[0];
  return r ? (r.role as Role) : null;
}

async function need(db: Db, ws: string, userId: string, admin = false): Promise<Role> {
  const role = await roleIn(db, ws, userId);
  if (!role) throw new TeamError("not_found");
  if (admin && role === "member") throw new TeamError("forbidden");
  return role;
}

export async function createWorkspace(db: Db, actor: string, rawName: string): Promise<string> {
  const name = rawName.trim().slice(0, 80);
  if (!name) throw new TeamError("invalid");
  const id = randomUUID();
  await db.query("insert into workspaces (id, name, created_by) values ($1, $2, $3)", [id, name, actor]);
  await db.query("insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')", [id, actor]);
  await audit(db, id, actor, "workspace.create", id, { name });
  return id;
}

export async function listWorkspaces(db: Db, userId: string): Promise<Workspace[]> {
  const r = await db.query(
    `select w.id, w.name, w.manager_brief, m.role, m.share_with_manager from workspaces w
     join workspace_members m on m.workspace_id = w.id where m.user_id = $1 order by w.created_at`,
    [userId],
  );
  return r.rows.map((x) => ({ id: String(x.id), name: String(x.name), role: x.role as Role, managerBrief: !!x.manager_brief, shareWithManager: !!x.share_with_manager }));
}

export async function listMembers(db: Db, actor: string, ws: string): Promise<Member[]> {
  await need(db, ws, actor);
  const r = await db.query(
    `select m.user_id, m.role, m.share_with_manager, m.joined_at, u.email, u.name, u.aliases from workspace_members m
     join users u on u.id = m.user_id where m.workspace_id = $1 order by m.joined_at`,
    [ws],
  );
  return r.rows.map((x) => ({
    userId: String(x.user_id), email: String(x.email), name: String(x.name ?? ""), aliases: (x.aliases as string[] | null) ?? [],
    role: x.role as Role, shareWithManager: !!x.share_with_manager, joinedAt: iso(x.joined_at),
  }));
}

/** Invite by email (admins). They join when they next sign in (acceptInvites). */
export async function invite(db: Db, actor: string, ws: string, rawEmail: string, role: Role = "member"): Promise<void> {
  const mine = await need(db, ws, actor, true);
  const email = normalizeEmail(rawEmail);
  if (!email || !ROLES.includes(role) || role === "owner") throw new TeamError("invalid");
  if (role === "admin" && mine !== "owner") throw new TeamError("forbidden");
  if ((await db.query("select 1 from workspace_invites where workspace_id = $1 and email = $2", [ws, email])).rows.length) {
    await db.query("update workspace_invites set role = $3, accepted_at = null where workspace_id = $1 and email = $2", [ws, email, role]);
  } else {
    await db.query("insert into workspace_invites (id, workspace_id, email, role, invited_by) values ($1, $2, $3, $4, $5)", [randomUUID(), ws, email, role, actor]);
  }
  await audit(db, ws, actor, "member.invite", email, { role });
}

/** Join every workspace that invited this email. Returns how many. */
export async function acceptInvites(db: Db, userId: string, email: string): Promise<number> {
  const r = await db.query("select id, workspace_id, role from workspace_invites where email = $1 and accepted_at is null", [email.toLowerCase()]);
  let n = 0;
  for (const inv of r.rows) {
    const ws = String(inv.workspace_id);
    if (!(await roleIn(db, ws, userId))) {
      await db.query("insert into workspace_members (workspace_id, user_id, role) values ($1, $2, $3)", [ws, userId, inv.role]);
      await audit(db, ws, userId, "member.join", userId, { role: inv.role });
      n++;
    }
    await db.query("update workspace_invites set accepted_at = now() where id = $1", [inv.id]);
  }
  return n;
}

async function owners(db: Db, ws: string): Promise<number> {
  return Number((await db.query("select count(*)::int as n from workspace_members where workspace_id = $1 and role = 'owner'", [ws])).rows[0]?.n ?? 0);
}

/** Owners change any role; admins only between member and admin, and never an owner's. */
export async function setRole(db: Db, actor: string, ws: string, target: string, role: Role): Promise<void> {
  if (!ROLES.includes(role)) throw new TeamError("invalid");
  const mine = await need(db, ws, actor, true);
  const theirs = await roleIn(db, ws, target);
  if (!theirs) throw new TeamError("not_found");
  if (mine !== "owner" && (theirs === "owner" || role === "owner")) throw new TeamError("forbidden");
  if (theirs === "owner" && role !== "owner" && (await owners(db, ws)) <= 1) throw new TeamError("last_owner");
  await db.query("update workspace_members set role = $3 where workspace_id = $1 and user_id = $2", [ws, target, role]);
  await audit(db, ws, actor, "member.role", target, { from: theirs, to: role });
}

/** Admins remove members (owners only by an owner); anyone may leave. The last owner can't go. */
export async function removeMember(db: Db, actor: string, ws: string, target: string): Promise<void> {
  const mine = await need(db, ws, actor, actor !== target);
  const theirs = await roleIn(db, ws, target);
  if (!theirs) throw new TeamError("not_found");
  if (actor !== target && theirs === "owner" && mine !== "owner") throw new TeamError("forbidden");
  if (theirs === "owner" && (await owners(db, ws)) <= 1) throw new TeamError("last_owner");
  await db.query("delete from item_shares where workspace_id = $1 and user_id = $2", [ws, target]);
  await db.query("delete from workspace_members where workspace_id = $1 and user_id = $2", [ws, target]);
  await audit(db, ws, actor, actor === target ? "member.leave" : "member.remove", target);
}

export async function setManagerBrief(db: Db, actor: string, ws: string, on: boolean): Promise<void> {
  await need(db, ws, actor, true);
  await db.query("update workspaces set manager_brief = $2 where id = $1", [ws, on]);
  await audit(db, ws, actor, "workspace.manager_brief", ws, { on });
}

/** A member's own opt-in: their shared open items appear in the owners' and admins' brief. */
export async function setShareWithManager(db: Db, actor: string, ws: string, on: boolean): Promise<void> {
  await need(db, ws, actor);
  await db.query("update workspace_members set share_with_manager = $3 where workspace_id = $1 and user_id = $2", [ws, actor, on]);
  await audit(db, ws, actor, "member.share_with_manager", actor, { on });
}

/** Share one of your own items with a workspace you're in. */
export async function shareItem(db: Db, actor: string, ws: string, itemId: string): Promise<void> {
  await need(db, ws, actor);
  if (!isUuid(itemId)) throw new TeamError("not_found");
  const it = (await db.query("select user_id from items where id = $1", [itemId])).rows[0];
  if (!it || String(it.user_id) !== actor) throw new TeamError("not_found");
  if (!(await db.query("select 1 from item_shares where item_id = $1 and workspace_id = $2", [itemId, ws])).rows.length) {
    await db.query("insert into item_shares (item_id, workspace_id, user_id) values ($1, $2, $3)", [itemId, ws, actor]);
    await audit(db, ws, actor, "item.share", itemId);
  }
}

export async function unshareItem(db: Db, actor: string, ws: string, itemId: string): Promise<void> {
  await need(db, ws, actor);
  if (!isUuid(itemId)) return;
  const r = await db.query("delete from item_shares where item_id = $1 and workspace_id = $2 and user_id = $3", [itemId, ws, actor]);
  if (r.rowCount) await audit(db, ws, actor, "item.unshare", itemId);
}

/** Workspace ids each of this user's items is shared with. */
export async function sharesOf(db: Db, userId: string): Promise<Map<string, string[]>> {
  const r = await db.query("select item_id, workspace_id from item_shares where user_id = $1", [userId]);
  const out = new Map<string, string[]>();
  for (const x of r.rows) out.set(String(x.item_id), [...(out.get(String(x.item_id)) ?? []), String(x.workspace_id)]);
  return out;
}

export interface SharedItem {
  itemId: string; kind: "owe" | "waiting" | "decision"; text: string; person: string | null; status: string;
  dueAt: string | null; createdAt: string; ownerId: string; ownerName: string; meetingTitle: string | null;
}

async function sharedItems(db: Db, ws: string): Promise<SharedItem[]> {
  const r = await db.query(
    `select i.id, i.kind, i.text, i.person, i.status, i.due_at, i.created_at, i.user_id, i.meeting_id, u.name, u.email
     from item_shares s join items i on i.id = s.item_id join users u on u.id = i.user_id
     where s.workspace_id = $1 order by i.created_at`,
    [ws],
  );
  const titles = new Map<string, string>();
  const ids = [...new Set(r.rows.map((x) => String(x.meeting_id)).filter(isUuid))];
  for (const id of ids) {
    const m = (await db.query("select title from meetings where id = $1", [id])).rows[0];
    if (m) titles.set(id, String(m.title));
  }
  return r.rows.map((x) => ({
    itemId: String(x.id), kind: x.kind as SharedItem["kind"], text: String(x.text), person: (x.person as string | null) ?? null,
    status: String(x.status), dueAt: isoOrNull(x.due_at), createdAt: iso(x.created_at), ownerId: String(x.user_id),
    ownerName: String(x.name || x.email), meetingTitle: titles.get(String(x.meeting_id)) ?? null,
  }));
}

/** The team's shared decisions, newest first. Members only. */
export async function decisionsLog(db: Db, actor: string, ws: string): Promise<SharedItem[]> {
  await need(db, ws, actor);
  return (await sharedItems(db, ws)).filter((i) => i.kind === "decision" && i.status !== "wrong").reverse();
}

export interface OweEdge { from: string; to: string; fromMember: boolean; toMember: boolean; items: SharedItem[] }

const lc = (s: string) => s.trim().toLowerCase();

/** Match a name said in a meeting to a member: full name, first name or an alias. */
export function matchMember(name: string, members: Array<Pick<Member, "userId" | "name" | "aliases" | "email">>): string | null {
  const n = lc(name);
  if (!n) return null;
  const first = (x: string) => x.split(/\s+/)[0];
  const names = (m: Pick<Member, "name" | "aliases">) => [m.name, ...m.aliases].filter(Boolean).map(lc);
  const exact = members.find((m) => names(m).includes(n));
  if (exact) return exact.userId;
  if (first(n).length < 3) return null;
  const byFirst = members.filter((m) => names(m).some((x) => first(x) === first(n)));
  return byFirst.length === 1 ? byFirst[0].userId : null; // two Ashas: don't guess
}

/**
 * Who owes whom, from open shared items only: "owe" (the sharer owes the person) and "waiting"
 * (the person owes the sharer). People who aren't members show by name.
 */
export async function whoOwesWhom(db: Db, actor: string, ws: string): Promise<OweEdge[]> {
  const members = await listMembers(db, actor, ws);
  const label = new Map(members.map((m) => [m.userId, m.name || m.email]));
  const edges = new Map<string, OweEdge>();
  for (const i of await sharedItems(db, ws)) {
    if (i.status !== "open" || i.kind === "decision" || !i.person) continue;
    const other = matchMember(i.person, members);
    const otherKey = other ?? `name:${lc(i.person)}`;
    const [fromKey, toKey] = i.kind === "owe" ? [i.ownerId, otherKey] : [otherKey, i.ownerId];
    if (fromKey === toKey) continue;
    const key = `${fromKey}>${toKey}`;
    const name = (k: string) => (k.startsWith("name:") ? i.person! : label.get(k) ?? k);
    const e = edges.get(key) ?? { from: name(fromKey), to: name(toKey), fromMember: !fromKey.startsWith("name:"), toMember: !toKey.startsWith("name:"), items: [] };
    e.items.push(i);
    edges.set(key, e);
  }
  return [...edges.values()].sort((x, y) => y.items.length - x.items.length || x.from.localeCompare(y.from));
}

/**
 * The manager brief: for each workspace with it on where this user is an owner or admin, one line
 * per member who opted in, from their open shared items only. Empty when there's nothing to say.
 */
export async function managerBriefLines(db: Db, managerId: string, now: Date): Promise<string[]> {
  const lines: string[] = [];
  for (const w of await listWorkspaces(db, managerId)) {
    if (!w.managerBrief || w.role === "member") continue;
    const members = (await listMembers(db, managerId, w.id)).filter((m) => m.shareWithManager && m.userId !== managerId);
    if (!members.length) continue;
    const items = (await sharedItems(db, w.id)).filter((i) => i.status === "open" && i.kind === "owe");
    for (const m of members) {
      const mine = items.filter((i) => i.ownerId === m.userId);
      if (!mine.length) continue;
      const late = mine.filter((i) => i.dueAt && Date.parse(i.dueAt) < now.getTime()).length;
      lines.push(`${w.name} · ${m.name || m.email}: ${mine.length} open${late ? `, ${late} late` : ""}`);
    }
  }
  return lines;
}

export interface AuditEntry { at: string; actor: string | null; action: string; target: string | null; payload: Record<string, unknown> }

/** Owners and admins only. Newest first. */
export async function auditLog(db: Db, actor: string, ws: string, limit = 100): Promise<AuditEntry[]> {
  await need(db, ws, actor, true);
  const r = await db.query(
    `select a.created_at, a.action, a.target, a.payload, u.email from audit_log a left join users u on u.id = a.actor_id
     where a.workspace_id = $1 order by a.id desc limit $2`,
    [ws, Math.min(500, limit)],
  );
  return r.rows.map((x) => ({ at: iso(x.created_at), actor: (x.email as string | null) ?? null, action: String(x.action), target: (x.target as string | null) ?? null, payload: (x.payload as Record<string, unknown>) ?? {} }));
}
