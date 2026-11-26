import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { Page } from "@/components/Page";
import { isHosted } from "@/server/mode";
import { rootStore, sessionUserId } from "@/server/hosted/app";
import { hostedConfig } from "@/server/hosted/config";
import * as teams from "@/server/hosted/teams";
import { changeRole, createTeam, inviteMember, leaveTeam, removeFromTeam, toggleManagerBrief, toggleShareWithManager } from "../hosted-actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Team" };

const ERRORS: Record<string, string> = {
  forbidden: "Only the team's owners and admins can do that.",
  not_found: "That isn't in this team.",
  invalid: "Check the name or email and try again.",
  last_owner: "A team needs an owner. Make someone else owner first.",
};

const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

// Hosted mode, teams on: your teams, their members, the shared decisions log, who owes whom, and
// (owners and admins) the audit log. Only items a member shared appear here.
export default async function Team({ searchParams }: { searchParams: Promise<{ ws?: string; error?: string }> }) {
  if (!isHosted() || !hostedConfig().teamsEnabled) notFound();
  const uid = await sessionUserId();
  if (!uid) redirect("/login");
  const db = rootStore().db;
  const mine = await teams.listWorkspaces(db, uid);
  const { ws: wsParam, error } = await searchParams;
  const ws = mine.find((w) => w.id === wsParam) ?? mine[0] ?? null;

  return (
    <Page title="Team">
      {error && ERRORS[error] ? <p className="db-note db-note--error" role="alert">{ERRORS[error]}</p> : null}
      {mine.length > 1 ? (
        <nav className="db-h-tabs" aria-label="Your teams">
          {mine.map((w) => <Link key={w.id} className={w.id === ws?.id ? "db-btn db-btn--primary" : "db-btn"} href={`/team?ws=${w.id}`}>{w.name}</Link>)}
        </nav>
      ) : null}
      {ws ? <TeamView uid={uid} ws={ws} /> : <p className="db-lead">Share chosen items with the people you work with: decisions, and who owes whom. Nothing is shared until you share it.</p>}
      <section className="db-h-card">
        <h2 className="db-h-card__title">New team</h2>
        <form action={createTeam} className="db-stack">
          <Field id="name" name="name" label="Name" required maxLength={80} />
          <div><Button type="submit" variant="secondary">Create team</Button></div>
        </form>
      </section>
    </Page>
  );
}

async function TeamView({ uid, ws }: { uid: string; ws: teams.Workspace }) {
  const db = rootStore().db;
  const admin = ws.role !== "member";
  const [members, decisions, owes, log] = await Promise.all([
    teams.listMembers(db, uid, ws.id),
    teams.decisionsLog(db, uid, ws.id),
    teams.whoOwesWhom(db, uid, ws.id),
    admin ? teams.auditLog(db, uid, ws.id, 50) : Promise.resolve([]),
  ]);
  return (
    <>
      <section className="db-h-card">
        <h2 className="db-h-card__title">{ws.name}</h2>
        <p className="db-h-muted">You are {ws.role === "owner" ? "an owner" : ws.role === "admin" ? "an admin" : "a member"}. Share an item from its page to add it here.</p>
        <form action={toggleShareWithManager} className="db-h-row">
          <input type="hidden" name="ws" value={ws.id} />
          <input type="hidden" name="on" value={ws.shareWithManager ? "0" : "1"} />
          <span className="db-h-muted">{ws.shareWithManager ? "Your shared open items are in the managers' brief." : "Your shared items stay out of the managers' brief."}</span>
          <Button type="submit" variant="ghost">{ws.shareWithManager ? "Stop" : "Include them"}</Button>
        </form>
      </section>

      <section className="db-h-card">
        <h2 className="db-h-card__title">Who owes whom</h2>
        {owes.length ? owes.map((e) => (
          <div key={`${e.from}>${e.to}`}>
            <div className="db-h-edge"><strong>{e.from}</strong> owes <strong>{e.to}</strong><span className="db-h-edge__n">{e.items.length}</span></div>
            <ul className="db-h-list">{e.items.map((i) => <li key={i.itemId}>{i.text}{i.meetingTitle ? <span className="db-h-muted"> · {i.meetingTitle}</span> : null}</li>)}</ul>
          </div>
        )) : <p className="db-h-muted">Nothing open is shared yet.</p>}
      </section>

      <section className="db-h-card">
        <h2 className="db-h-card__title">Decisions</h2>
        {decisions.length ? (
          <ul className="db-h-list">{decisions.map((d) => <li key={d.itemId}>{d.text} <span className="db-h-muted">· {d.ownerName}{d.meetingTitle ? `, ${d.meetingTitle}` : ""} · {when(d.createdAt)}</span></li>)}</ul>
        ) : <p className="db-h-muted">No shared decisions yet.</p>}
      </section>

      <section className="db-h-card">
        <h2 className="db-h-card__title">Members</h2>
        <div className="db-h-scroll">
          <table className="db-h-table">
            <thead><tr><th>Name</th><th>Role</th>{admin ? <th /> : null}</tr></thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.userId}>
                  <td>{m.name || m.email}<div className="db-h-muted">{m.email}</div></td>
                  <td>
                    {admin && m.userId !== uid ? (
                      <form action={changeRole} className="db-h-row">
                        <input type="hidden" name="ws" value={ws.id} /><input type="hidden" name="user" value={m.userId} />
                        <select className="db-h-select" name="role" defaultValue={m.role} aria-label={`Role for ${m.name || m.email}`}>
                          {(ws.role === "owner" ? teams.ROLES : teams.ROLES.filter((r) => r !== "owner")).map((r) => <option key={r} value={r}>{r}</option>)}
                        </select>
                        <Button type="submit" variant="ghost">Change</Button>
                      </form>
                    ) : m.role}
                  </td>
                  {admin ? (
                    <td>{m.userId !== uid ? (
                      <form action={removeFromTeam}><input type="hidden" name="ws" value={ws.id} /><input type="hidden" name="user" value={m.userId} /><Button type="submit" variant="ghost">Remove</Button></form>
                    ) : null}</td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {admin ? (
          <form action={inviteMember} className="db-stack">
            <input type="hidden" name="ws" value={ws.id} />
            <Field id="invite" name="email" type="email" label="Invite by email" hint="They join when they next sign in." required />
            <div className="db-h-row">
              <select className="db-h-select" name="role" defaultValue="member" aria-label="Role"><option value="member">member</option>{ws.role === "owner" ? <option value="admin">admin</option> : null}</select>
              <Button type="submit" variant="secondary">Invite</Button>
            </div>
          </form>
        ) : null}
        <form action={leaveTeam}><input type="hidden" name="ws" value={ws.id} /><Button type="submit" variant="ghost">Leave team</Button></form>
      </section>

      {admin ? (
        <section className="db-h-card">
          <h2 className="db-h-card__title">Admin</h2>
          <form action={toggleManagerBrief} className="db-h-row">
            <input type="hidden" name="ws" value={ws.id} />
            <input type="hidden" name="on" value={ws.managerBrief ? "0" : "1"} />
            <span className="db-h-muted">Manager brief is {ws.managerBrief ? "on" : "off"}: owners and admins get a line per member who opted in, in their daily brief.</span>
            <Button type="submit" variant="ghost">{ws.managerBrief ? "Turn off" : "Turn on"}</Button>
          </form>
          <h3 className="db-h-card__title">Audit log</h3>
          <div className="db-h-scroll">
            <table className="db-h-table">
              <thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead>
              <tbody>{log.map((l, k) => <tr key={k}><td className="db-mono">{when(l.at)}</td><td>{l.actor ?? "deleted user"}</td><td>{l.action}{l.payload.role ? ` (${String(l.payload.role)})` : ""}{l.payload.to ? ` → ${String(l.payload.to)}` : ""}</td></tr>)}</tbody>
            </table>
          </div>
        </section>
      ) : null}
    </>
  );
}
