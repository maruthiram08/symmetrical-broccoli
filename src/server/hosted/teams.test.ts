import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "./db";
import { HostedStore } from "./store";
import {
  acceptInvites, auditLog, createWorkspace, decisionsLog, invite, listMembers, listWorkspaces, managerBriefLines, matchMember,
  removeMember, setManagerBrief, setRole, setShareWithManager, shareItem, TeamError, unshareItem, whoOwesWhom,
} from "./teams";
import { memDb, TEST_KEY } from "./testing";

const AT = "2026-11-20T10:00:00.000Z";
const NOW = new Date("2026-11-25T10:00:00.000Z");
let db: Db, store: HostedStore, owner: string, asha: string, ravi: string, ws: string;

async function user(email: string, name: string) {
  const id = randomUUID();
  await store.ensureUser(id, email);
  await store.updateUser(id, { name });
  return id;
}
const code = (p: Promise<unknown>) => p.then(() => "ok", (e) => (e instanceof TeamError ? e.code : String(e)));

beforeEach(async () => {
  db = memDb().db;
  store = new HostedStore(db, null, TEST_KEY);
  owner = await user("maru@x.com", "Maruthi Ram");
  asha = await user("asha@x.com", "Asha Kumar");
  ravi = await user("ravi@x.com", "Ravi");
  ws = await createWorkspace(db, owner, " Growth team ");
  await invite(db, owner, ws, "ASHA@x.com");
  await invite(db, owner, ws, "ravi@x.com");
  await acceptInvites(db, asha, "asha@x.com");
  await acceptInvites(db, ravi, "ravi@x.com");
});

describe("workspaces and roles", () => {
  it("the creator owns it and invited people join on sign-in", async () => {
    expect(await listWorkspaces(db, owner)).toEqual([expect.objectContaining({ name: "Growth team", role: "owner" })]);
    expect((await listMembers(db, asha, ws)).map((m) => [m.name, m.role])).toEqual([["Maruthi Ram", "owner"], ["Asha Kumar", "member"], ["Ravi", "member"]]);
    expect(await acceptInvites(db, asha, "asha@x.com")).toBe(0);
  });

  it("non-members see nothing; members can't administer", async () => {
    const out = await user("out@x.com", "Out");
    expect(await code(listMembers(db, out, ws))).toBe("not_found");
    expect(await code(decisionsLog(db, out, ws))).toBe("not_found");
    expect(await code(invite(db, asha, ws, "z@x.com"))).toBe("forbidden");
    expect(await code(setRole(db, asha, ws, ravi, "admin"))).toBe("forbidden");
    expect(await code(removeMember(db, asha, ws, ravi))).toBe("forbidden");
    expect(await code(auditLog(db, asha, ws))).toBe("forbidden");
    expect(await code(setManagerBrief(db, asha, ws, true))).toBe("forbidden");
  });

  it("admins manage members but not owners; the last owner stays", async () => {
    await setRole(db, owner, ws, asha, "admin");
    expect(await code(setRole(db, asha, ws, owner, "member"))).toBe("forbidden");
    expect(await code(setRole(db, asha, ws, ravi, "owner"))).toBe("forbidden");
    expect(await code(invite(db, asha, ws, "z@x.com", "admin"))).toBe("forbidden");
    expect(await code(setRole(db, owner, ws, owner, "member"))).toBe("last_owner");
    expect(await code(removeMember(db, owner, ws, owner))).toBe("last_owner");
    await removeMember(db, asha, ws, ravi);
    expect((await listMembers(db, owner, ws)).map((m) => m.name)).toEqual(["Maruthi Ram", "Asha Kumar"]);
    await removeMember(db, asha, ws, asha);
    expect(await listWorkspaces(db, asha)).toEqual([]);
  });

  it("writes everything to the audit log, newest first", async () => {
    await setRole(db, owner, ws, asha, "admin");
    const log = await auditLog(db, owner, ws);
    expect(log[0]).toMatchObject({ action: "member.role", actor: "maru@x.com", target: asha, payload: { from: "member", to: "admin" } });
    expect(log.map((l) => l.action)).toEqual(expect.arrayContaining(["workspace.create", "member.invite", "member.join"]));
  });
});

describe("sharing", () => {
  it("only your own items, only when you choose; removed members' shares go too", async () => {
    const mine = await store.addManualItem(asha, { kind: "owe", text: "Send Ravi the deck", person: "Ravi", dueAt: null }, AT);
    expect(await code(shareItem(db, ravi, ws, mine.id))).toBe("not_found");
    expect(await whoOwesWhom(db, owner, ws)).toEqual([]);
    await shareItem(db, asha, ws, mine.id);
    await shareItem(db, asha, ws, mine.id);
    expect((await whoOwesWhom(db, owner, ws))[0].items).toHaveLength(1);
    await unshareItem(db, asha, ws, mine.id);
    expect(await whoOwesWhom(db, owner, ws)).toEqual([]);
    await shareItem(db, asha, ws, mine.id);
    await removeMember(db, owner, ws, asha);
    expect(await whoOwesWhom(db, owner, ws)).toEqual([]);
  });

  it("who owes whom joins owe and waiting items across members, and names outsiders", async () => {
    const add = async (u: string, kind: "owe" | "waiting", text: string, person: string) => {
      const i = await store.addManualItem(u, { kind, text, person, dueAt: null }, AT);
      await shareItem(db, u, ws, i.id);
      return i;
    };
    await add(asha, "owe", "Send Ravi the deck", "Ravi");
    await add(ravi, "waiting", "Asha sends the deck", "Asha");
    await add(owner, "waiting", "Nitin shares the logo", "Nitin");
    const done = await add(asha, "owe", "Old thing", "Ravi");
    await store.setItemStatus(done.id, "done", AT);
    const edges = await whoOwesWhom(db, owner, ws);
    expect(edges.map((e) => [e.from, e.to, e.items.length, e.toMember])).toEqual([
      ["Asha Kumar", "Ravi", 2, true],
      ["Nitin", "Maruthi Ram", 1, true],
    ]);
    expect(edges[1].fromMember).toBe(false);
  });

  it("the decisions log lists shared decisions only", async () => {
    const { meeting } = await store.upsertMeeting({ userId: asha, providerMeetingId: "p", title: "Pricing", startedAt: AT, participants: [] });
    await store.commitExtraction({ meetingId: meeting.id, userId: asha, at: AT, closes: [], newItems: [
      { kind: "decision", text: "Price is ₹500", person: null, quote: "q", meetingId: meeting.id, dueAt: null },
      { kind: "decision", text: "Private call", person: null, quote: "q", meetingId: meeting.id, dueAt: null },
    ] });
    const [shared] = await store.listItems(asha);
    await shareItem(db, asha, ws, shared.id);
    expect(await decisionsLog(db, ravi, ws)).toEqual([expect.objectContaining({ text: "Price is ₹500", ownerName: "Asha Kumar", meetingTitle: "Pricing" })]);
  });
});

describe("manager brief", () => {
  it("needs the workspace switch and each member's own opt-in, and counts shared items only", async () => {
    const i = await store.addManualItem(asha, { kind: "owe", text: "Ship it", person: "Ravi", dueAt: "2026-11-24T10:00:00.000Z" }, AT);
    await store.addManualItem(asha, { kind: "owe", text: "Not shared", person: "Ravi", dueAt: null }, AT);
    await shareItem(db, asha, ws, i.id);
    expect(await managerBriefLines(db, owner, NOW)).toEqual([]);
    await setManagerBrief(db, owner, ws, true);
    expect(await managerBriefLines(db, owner, NOW)).toEqual([]);
    await setShareWithManager(db, asha, ws, true);
    expect(await managerBriefLines(db, owner, NOW)).toEqual(["Growth team · Asha Kumar: 1 open, 1 late"]);
    expect(await managerBriefLines(db, ravi, NOW)).toEqual([]);
  });
});

describe("matchMember", () => {
  const ms = [
    { userId: "1", name: "Asha Kumar", aliases: [], email: "" },
    { userId: "2", name: "Asha Rao", aliases: ["AR"], email: "" },
    { userId: "3", name: "Ravi", aliases: [], email: "" },
  ];
  it("matches full names and aliases, and a first name only when unambiguous", () => {
    expect(matchMember("asha rao", ms)).toBe("2");
    expect(matchMember("AR", ms)).toBe("2");
    expect(matchMember("Asha", ms)).toBeNull();
    expect(matchMember("Ravi S", ms)).toBe("3");
    expect(matchMember("Nitin", ms)).toBeNull();
  });
});
