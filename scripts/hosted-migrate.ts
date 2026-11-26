// npm run hosted:migrate [-- --env .env.hosted]
// Applies supabase/migrations/*.sql in order to DATABASE_URL, each once, each in a transaction.
// (Same SQL you could paste into the Supabase SQL editor; this just remembers what ran.)
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { sslFor } from "../src/server/hosted/db";
import { loadEnvFile } from "./hosted-env";

async function main() {
  loadEnvFile(process.argv);
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const db = new Client({ connectionString: url, ssl: sslFor(url, process.env.DATABASE_CA_CERT) });
  await db.connect();
  try {
    await db.query("create table if not exists _daily_brief_migrations (name text primary key, applied_at timestamptz not null default now())");
    await db.query("alter table _daily_brief_migrations enable row level security");
    const dir = join(process.cwd(), "supabase", "migrations");
    const done = new Set((await db.query("select name from _daily_brief_migrations")).rows.map((r) => r.name as string));
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
      if (done.has(f)) { console.log(`  skip   ${f}`); continue; }
      await db.query("begin");
      try {
        await db.query(readFileSync(join(dir, f), "utf8"));
        await db.query("insert into _daily_brief_migrations (name) values ($1)", [f]);
        await db.query("commit");
        console.log(`  apply  ${f}`);
      } catch (e) {
        await db.query("rollback");
        throw new Error(`${f} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  } finally {
    await db.end();
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
