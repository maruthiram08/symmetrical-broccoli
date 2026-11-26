import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATIONS_DIR } from "./testing";

const all = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
const sql = all.map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8")).join("\n");
const tables = [...sql.matchAll(/create table (\w+)/g)].map((m) => m[1]);

describe("migrations", () => {
  it("are numbered in order", () => {
    expect(all).toEqual(["0001_schema.sql", "0002_billing_teams.sql", "0003_security.sql", "0004_local_parity.sql"]);
  });

  it("turn on row-level security for every table", () => {
    expect(tables.length).toBeGreaterThan(15);
    for (const t of tables) expect(sql, t).toContain(`alter table ${t} enable row level security;`);
  });

  it("give every per-user table a policy on auth.uid(), and secrets none", () => {
    for (const t of ["meetings", "items", "briefs", "events", "looks", "marks", "caches", "health", "ai_state", "subscriptions"]) {
      expect(sql, t).toMatch(new RegExp(`create policy \\w+ on ${t} [^;]*auth\\.uid\\(\\)`));
    }
    for (const t of ["connections", "oauth_clients", "billing_events", "prep_notified"]) {
      expect(sql, t).not.toMatch(new RegExp(`create policy \\w+ on ${t} `));
    }
  });
});
