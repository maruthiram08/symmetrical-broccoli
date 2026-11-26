// Postgres access for hosted mode (Supabase's database, reached with DATABASE_URL).
// Direct SQL rather than the REST API, so commits are real transactions and per-user job locks
// are real advisory locks held on one connection for as long as the job runs.
import { Pool, type QueryResultRow } from "pg";

export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

export interface PooledClient extends Queryable {
  release(): void;
}

/** A pool of connections (pg.Pool, or pg-mem's adapter in tests). */
export interface Db extends Queryable {
  connect(): Promise<PooledClient>;
}

const g = globalThis as unknown as { __dbPgPool?: Pool };

/**
 * The shared pool. Use the Supabase *session* pooler or the direct connection (port 5432):
 * advisory locks need a session. Small on purpose: Vercel runs many short functions.
 */
export function getDb(): Db {
  if (!g.__dbPgPool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("Missing environment variable DATABASE_URL (hosted mode)");
    const ca = process.env.DATABASE_CA_CERT?.replace(/\\n/g, "\n");
    g.__dbPgPool = new Pool({
      connectionString: url,
      max: Number(process.env.DATABASE_POOL_MAX ?? 4),
      idleTimeoutMillis: 10_000,
      // Supabase signs its certificates with its own CA: pass it in DATABASE_CA_CERT to verify.
      ssl: ca ? { ca, rejectUnauthorized: true } : /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false },
    });
  }
  return g.__dbPgPool as unknown as Db;
}

/** Run fn in one transaction on one connection. Rolls back on any error. */
export async function tx<T>(db: Db, fn: (q: Queryable) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    await c.query("begin");
    const out = await fn(c);
    await c.query("commit");
    return out;
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** Lock key for one user's jobs. hashtextextended gives a stable bigint for the text. */
const LOCK_SQL = "select pg_try_advisory_lock(hashtextextended($1, 0)) as ok";
const UNLOCK_SQL = "select pg_advisory_unlock(hashtextextended($1, 0)) as ok";

export type Locked<T> = { locked: true; value: T } | { locked: false };

/**
 * Run fn while holding this user's job lock (a session advisory lock). When another run holds it,
 * returns { locked: false } at once instead of waiting: the next cron tick tries again. If the
 * function dies, Postgres drops the connection and the lock with it, so a lock never sticks.
 */
export async function withUserLock<T>(db: Db, userId: string, fn: () => Promise<T>): Promise<Locked<T>> {
  const key = `daily-brief:user:${userId}`;
  const c = await db.connect();
  let held = false;
  try {
    const r = await c.query<{ ok: boolean }>(LOCK_SQL, [key]);
    held = !!r.rows[0]?.ok;
    if (!held) return { locked: false };
    return { locked: true, value: await fn() };
  } finally {
    if (held) await c.query(UNLOCK_SQL, [key]).catch(() => undefined);
    c.release();
  }
}

/** Postgres gives Date objects (pg) or strings; the app compares ISO strings. */
export function iso(v: unknown): string {
  return (v instanceof Date ? v : new Date(String(v))).toISOString();
}
export function isoOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : iso(v);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Ids come from URLs and forms: anything that isn't a uuid can't match a row (and must not reach a uuid column). */
export const isUuid = (s: unknown): s is string => typeof s === "string" && UUID.test(s);
