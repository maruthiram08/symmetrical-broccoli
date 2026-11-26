// Test helper: a Postgres in memory (pg-mem) with the hosted migrations applied.
// 0003_security.sql (RLS policies, auth.uid()) is Supabase-only and is checked as text instead.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DataType, newDb } from "pg-mem";
import type { Db } from "./db";

export const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");
export const TABLE_MIGRATIONS = ["0001_schema.sql", "0002_billing_teams.sql"];

export function memDb(): { db: Db; locks: Set<string> } {
  const mem = newDb();
  const locks = new Set<string>();
  mem.public.registerFunction({ name: "gen_random_uuid", returns: DataType.uuid, implementation: () => randomUUID(), impure: true });
  mem.public.registerFunction({ name: "hashtextextended", args: [DataType.text, DataType.integer], returns: DataType.text, implementation: (s: string) => s });
  mem.public.registerFunction({
    name: "pg_try_advisory_lock", args: [DataType.text], returns: DataType.bool, impure: true,
    implementation: (k: string) => (locks.has(k) ? false : (locks.add(k), true)),
  });
  mem.public.registerFunction({ name: "pg_advisory_unlock", args: [DataType.text], returns: DataType.bool, impure: true, implementation: (k: string) => locks.delete(k) });
  for (const f of TABLE_MIGRATIONS) mem.public.none(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  const { Pool } = mem.adapters.createPg();
  return { db: new Pool() as unknown as Db, locks };
}

export const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
