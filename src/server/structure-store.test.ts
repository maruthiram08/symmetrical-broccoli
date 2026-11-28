// Tags, projects and saved views in both stores: the local FileStore and the hosted Postgres store.
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DataType, newDb } from "pg-mem";
import { describe, expect, it } from "vitest";
import type { SavedView } from "@/lib/structure/views";
import type { Db } from "@/server/hosted/db";
import { HostedStore, WrongUserError } from "@/server/hosted/store";
import { MIGRATIONS_DIR, memDb, TEST_KEY } from "@/server/hosted/testing";
import { FileStore } from "@/server/local/file-store";

const AT = "2026-11-26T10:00:00.000Z";
const view = (id: string, name = "Open by project"): SavedView => ({
  id, name, source: "items", layout: "kanban", filters: [{ field: "status", op: "is", value: "open" }], sort: { field: "due", dir: "asc" }, group: "project", createdAt: AT, updatedAt: AT,
});

describe("FileStore: tags, projects and views", () => {
  it("loads a state.json from before views and tags, unchanged", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "db-structure-")), ".daily-brief");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "state.json");
    const old = {
      version: 1, users: [{ id: "u1", email: "you@this-mac", name: "M", aliases: [], timeZone: "Asia/Kolkata", briefTime: "18:00", createdAt: AT }],
      connections: [], meetings: [], briefs: [], oauthClients: [], events: [],
      items: [{ id: "i1", userId: "u1", kind: "owe", text: "Send the deck", person: "Nitin", quote: "q", meetingId: "m", dueAt: null, status: "open", closedByMeetingId: null, closeQuote: null, createdAt: AT, closedAt: null }],
    };
    writeFileSync(path, JSON.stringify(old));
    const s = new FileStore(path);
    const [item] = await s.listItems("u1");
    expect(item.tags).toBeUndefined();
    expect(item.project).toBeUndefined();
    expect(await s.listViews("u1")).toEqual([]);
    // A write without views or tags doesn't add empty fields to the file.
    await s.setItemStatus("i1", "done", AT);
    expect(JSON.parse(readFileSync(path, "utf8")).views).toBeUndefined();
  });

  it("keeps tags, projects and views across restarts", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "db-structure-")), ".daily-brief", "state.json");
    const a = new FileStore(path);
    const u = a.addUser({ email: "you@this-mac", name: "M" });
    const item = await a.addManualItem(u.id, { kind: "owe", text: "Send the deck", person: "Nitin", dueAt: null, tags: ["launch", "launch"], project: "q4-launch" }, AT);
    expect(item).toMatchObject({ tags: ["launch"], project: "q4-launch" });
    await a.updateItem(item.id, { tags: ["launch", "ops/infra"] });
    await a.saveView(u.id, view("v1"));
    await a.saveView(u.id, view("v2", "Second"));
    await a.saveView(u.id, { ...view("v1", "Renamed"), layout: "table" });

    const b = new FileStore(path);
    expect((await b.listItems(u.id))[0]).toMatchObject({ tags: ["launch", "ops/infra"], project: "q4-launch" });
    expect((await b.listViews(u.id)).map((v) => [v.id, v.name, v.layout])).toEqual([["v1", "Renamed", "table"], ["v2", "Second", "kanban"]]);
    expect(await b.deleteView(u.id, "v1")).toBe(true);
    expect(await b.deleteView(u.id, "v1")).toBe(false);
    await b.updateItem(item.id, { project: null, tags: [] });
    const c = new FileStore(path);
    expect((await c.listViews(u.id)).map((v) => v.id)).toEqual(["v2"]);
    expect((await c.listItems(u.id))[0].project).toBeNull();
  });
});

describe("HostedStore: tags, projects and views", () => {
  it("migrates existing items to no tags and no project", async () => {
    // A database at 0004 with an item in it, then 0005 applied on top.
    const mem = newDb();
    mem.public.registerFunction({ name: "gen_random_uuid", returns: DataType.uuid, implementation: () => randomUUID(), impure: true });
    for (const f of ["0001_schema.sql", "0002_billing_teams.sql", "0004_local_parity.sql"]) mem.public.none(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    const { Pool } = mem.adapters.createPg();
    const db = new Pool() as unknown as Db;
    const store = new HostedStore(db, null, TEST_KEY);
    const uid = randomUUID();
    await store.ensureUser(uid, "a@x.com");
    await db.query("insert into items (id, user_id, kind, text, person, quote, meeting_id, due_at, status, created_at, source) values ($1, $2, 'owe', 'Old item', null, '', 'manual', null, 'open', $3, 'manual')", [randomUUID(), uid, AT]);
    mem.public.none(readFileSync(join(MIGRATIONS_DIR, "0005_structure.sql"), "utf8"));
    const [item] = await store.listItems(uid);
    expect(item.text).toBe("Old item");
    expect(item.tags).toBeUndefined();
    expect(item.project).toBeUndefined();
    expect(await store.listViews(uid)).toEqual([]);
  });

  it("stores tags, projects and views per user", async () => {
    const root = new HostedStore(memDb().db, null, TEST_KEY);
    const a = randomUUID(), b = randomUUID();
    await root.ensureUser(a, "a@x.com");
    await root.ensureUser(b, "b@x.com");
    const item = await root.addManualItem(a, { kind: "waiting", text: "Tarun to send the spec", person: "Tarun", dueAt: null, tags: ["api"], project: "q4-launch" }, AT);
    expect((await root.listItems(a))[0]).toMatchObject({ tags: ["api"], project: "q4-launch" });
    await root.updateItem(item.id, { tags: ["api", "launch/web"], project: null });
    const back = (await root.listItems(a))[0];
    expect(back.tags).toEqual(["api", "launch/web"]);
    expect(back.project).toBeUndefined();

    await root.saveView(a, view("v1"));
    await root.saveView(a, view("v2", "Second"));
    await root.saveView(a, { ...view("v1", "Renamed"), group: "status" });
    expect((await root.listViews(a)).map((v) => [v.id, v.name, v.group])).toEqual([["v1", "Renamed", "status"], ["v2", "Second", "project"]]);
    expect(await root.listViews(b)).toEqual([]);

    const scoped = root.forUser(b);
    await expect(scoped.listViews(a)).rejects.toBeInstanceOf(WrongUserError);
    await expect(scoped.saveView(a, view("x"))).rejects.toBeInstanceOf(WrongUserError);
    expect(await scoped.deleteView(b, "v1")).toBe(false);
    expect(await root.deleteView(a, "v1")).toBe(true);
    expect((await root.listViews(a)).map((v) => v.id)).toEqual(["v2"]);
  });
});
