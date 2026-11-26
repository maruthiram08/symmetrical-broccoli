// Runs only with HOSTED_TEST_DATABASE_URL set to a throwaway Postgres (superuser), e.g. a local
// postgres:16. Creates a fresh database with a stand-in for Supabase's auth schema, applies every
// migration (RLS included) and checks the store, the job locks and the policies on real Postgres.
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { confirmNew } from "@/lib/directory/directory";
import { withUserLock, type Db } from "./db";
import { HostedStore } from "./store";
import { MIGRATIONS_DIR, TEST_KEY } from "./testing";

const URL_ = process.env.HOSTED_TEST_DATABASE_URL;
const AT = "2026-11-25T12:00:00.000Z";

const SUPABASE_STANDIN = `
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;
create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated;
grant usage on schema public to anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated;
`;

describe.skipIf(!URL_)("HostedStore on real Postgres", () => {
  const name = `brief_test_${randomUUID().slice(0, 8)}`;
  let pool: Pool;
  let db: Db;
  let root: HostedStore;
  let a: string, b: string;

  beforeAll(async () => {
    const admin = new Client({ connectionString: URL_ });
    await admin.connect();
    await admin.query(`create database ${name}`);
    await admin.end();
    const url = new URL(URL_!);
    url.pathname = `/${name}`;
    pool = new Pool({ connectionString: url.toString(), max: 6 });
    pool.on("error", () => undefined);
    await pool.query(SUPABASE_STANDIN);
    for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith(".sql")).sort()) await pool.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    db = pool as unknown as Db;
    root = new HostedStore(db, null, TEST_KEY);
    a = randomUUID(); b = randomUUID();
    await pool.query("insert into auth.users (id, email) values ($1, 'a@x.com'), ($2, 'b@x.com')", [a, b]);
    await root.ensureUser(a, "a@x.com");
    await root.ensureUser(b, "b@x.com");
  });

  afterAll(async () => {
    await pool?.end();
    const admin = new Client({ connectionString: URL_ });
    await admin.connect();
    await admin.query(`drop database if exists ${name} with (force)`);
    await admin.end();
  });

  it("upserts, commits once in a transaction and counts reads", async () => {
    const one = await root.upsertMeeting({ userId: a, providerMeetingId: "p1", title: "One", startedAt: AT, participants: ["N"] });
    const two = await root.upsertMeeting({ userId: a, providerMeetingId: "p1", title: "One", startedAt: AT, participants: ["N"] });
    expect([one.created, two.created]).toEqual([true, false]);
    const args = { meetingId: one.meeting.id, userId: a, at: AT, closes: [], newItems: [{ kind: "owe" as const, text: "Send it", person: "N", quote: "q", meetingId: one.meeting.id, dueAt: null }] };
    await Promise.all([root.commitExtraction(args), root.commitExtraction(args)]);
    expect(await root.listItems(a)).toHaveLength(1);
    expect(await root.countProcessedSince(a, "2026-11-01T00:00:00.000Z")).toBe(1);
    expect(await root.listMeetingsBetween(a, "0000", "9999")).toHaveLength(1);
  });

  it("rolls the whole commit back when one write fails", async () => {
    const { meeting } = await root.upsertMeeting({ userId: a, providerMeetingId: "p2", title: "Two", startedAt: AT, participants: [] });
    await expect(root.commitExtraction({ meetingId: meeting.id, userId: a, at: AT, closes: [], newItems: [
      { kind: "owe", text: "fine", person: null, quote: "", meetingId: meeting.id, dueAt: null },
      { kind: "owe", text: "bad date", person: null, quote: "", meetingId: meeting.id, dueAt: "not a date" },
    ] })).rejects.toThrow();
    expect((await root.getMeeting(meeting.id))?.processedAt).toBeNull();
    expect((await root.listItems(a)).map((i) => i.text)).not.toContain("fine");
  });

  it("re-read keeps marks", async () => {
    const [item] = await root.listItems(a);
    await root.setItemStatus(item.id, "wrong", AT);
    await root.resetExtraction(a);
    const m = (await root.listMeetingsBetween(a, "0000", "9999")).find((x) => x.providerMeetingId === "p1")!;
    await root.commitExtraction({ meetingId: m.id, userId: a, at: "2026-11-26T00:00:00.000Z", closes: [], newItems: [{ kind: "owe", text: "Send it", person: "N", quote: "q", meetingId: m.id, dueAt: null }] });
    expect((await root.listItems(a))[0].status).toBe("wrong");
  });

  it("holds an advisory lock per user across connections", async () => {
    const order: string[] = [];
    const r = await withUserLock(db, a, async () => {
      const inner = await withUserLock(db, a, async () => "no");
      const other = await withUserLock(db, b, async () => "b ok");
      order.push(JSON.stringify(inner), JSON.stringify(other));
      return 1;
    });
    expect(r).toEqual({ locked: true, value: 1 });
    expect(order).toEqual(['{"locked":false}', '{"locked":true,"value":"b ok"}']);
    expect(await withUserLock(db, a, async () => 2)).toEqual({ locked: true, value: 2 });
  });

  it("row-level security shows a signed-in user only their own rows, and no secrets", async () => {
    await root.addManualItem(b, { kind: "owe", text: "B's", person: null, dueAt: null }, AT);
    await root.saveConnection({ userId: a, provider: "wispr_flow", accessToken: "t", refreshToken: "r", expiresAt: AT, lastSeenAt: null, status: "active" });
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("set local role authenticated");
      await c.query("select set_config('request.jwt.claim.sub', $1, true)", [a]);
      const items = (await c.query("select user_id from items")).rows;
      expect(items.length).toBeGreaterThan(0);
      expect(items.every((r) => r.user_id === a)).toBe(true);
      expect((await c.query("select id from users")).rows).toEqual([{ id: a }]);
      expect((await c.query("select * from connections")).rows).toEqual([]);
      await c.query("update items set text = 'x' where user_id = $1", [b]);
      await c.query("rollback");
      await c.query("begin");
      await c.query("set local role anon");
      await expect(c.query("select * from items")).rejects.toThrow(/permission denied/);
      await c.query("rollback");
    } finally {
      c.release();
    }
    expect((await root.listItems(b)).map((i) => i.text)).toEqual(["B's"]);
  });

  it("people changes lock and update the directory, and concurrent changes both land", async () => {
    const plan = (name: string) => (d: Parameters<typeof confirmNew>[0], ctx: Parameters<typeof confirmNew>[2]) => confirmNew(d, { name, spellings: [name] }, ctx);
    await Promise.all([root.changePeople(a, plan("Ravi"), AT), root.changePeople(a, plan("Meera"), AT)]);
    expect((await root.getPeople(a)).people.map((p) => p.name).sort()).toEqual(["Meera", "Ravi"]);
    const [last] = await root.listPeopleChanges(a);
    expect((await root.undoPeopleChange(a, last.id))?.undone).toBe(true);
    expect((await root.getPeople(a)).people).toHaveLength(1);
  });

  it("deleting the auth account deletes everything", async () => {
    await pool.query("delete from auth.users where id = $1", [b]);
    expect(await root.getUser(b)).toBeNull();
    expect((await pool.query("select count(*)::int as n from items where user_id = $1", [b])).rows[0].n).toBe(0);
  });
});
