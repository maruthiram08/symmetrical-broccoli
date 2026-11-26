// npm run hosted:check [-- --env .env.hosted] [-- --connect]
// Checks the hosted-mode environment variables. With --connect it also opens the database and
// checks every migration has been applied. Prints names and reasons, never secret values.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { checkHostedEnv } from "../src/server/hosted/config";
import { loadEnvFile } from "./hosted-env";

async function main() {
  const file = loadEnvFile(process.argv);
  if (file) console.log(`Reading ${file}`);
  const { errors, warnings } = checkHostedEnv(process.env);
  for (const w of warnings) console.log(`  warning  ${w}`);
  for (const e of errors) console.log(`  problem  ${e}`);
  if (process.argv.includes("--connect") && process.env.DATABASE_URL) {
    const ca = process.env.DATABASE_CA_CERT?.replace(/\\n/g, "\n");
    const db = new Client({ connectionString: process.env.DATABASE_URL, ssl: ca ? { ca } : { rejectUnauthorized: false } });
    try {
      await db.connect();
      const want = readdirSync(join(process.cwd(), "supabase", "migrations")).filter((f) => f.endsWith(".sql")).sort();
      const have = new Set((await db.query("select name from _daily_brief_migrations").catch(() => ({ rows: [] as Array<{ name: string }> }))).rows.map((r) => r.name));
      const missing = want.filter((f) => !have.has(f));
      if (missing.length) errors.push(`migrations not applied: ${missing.join(", ")} (npm run hosted:migrate)`);
      else console.log(`  ok       database reachable, ${want.length} migrations applied`);
    } catch (e) {
      errors.push(`can't reach the database: ${e instanceof Error ? e.message.replace(/postgres(ql)?:\/\/\S+/g, "<url>") : "error"}`);
    } finally {
      await db.end().catch(() => undefined);
    }
  }
  if (errors.length) {
    console.log(`\n${errors.length} problem${errors.length === 1 ? "" : "s"}. See docs/HOSTED.md.`);
    process.exit(1);
  }
  console.log("\nHosted environment looks complete.");
}

void main();
