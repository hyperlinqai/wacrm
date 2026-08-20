import 'server-only';
import { Pool } from 'pg';

// Single shared pool per server process. DATABASE_URL should be a role
// that is a member of anon / authenticated / service_role (e.g. the
// `authenticator` role) — every query runs inside a transaction that
// downgrades to the JWT role via SET LOCAL, so RLS applies exactly as
// it did under PostgREST.
declare global {
  // eslint-disable-next-line no-var
  var __wacrmPgPool: Pool | undefined;
}

export function getPool(): Pool {
  if (!globalThis.__wacrmPgPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set — the app cannot reach Postgres.');
    }
    globalThis.__wacrmPgPool = new Pool({
      connectionString,
      max: Number(process.env.DATABASE_POOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    // Surface idle-client errors (e.g. Postgres restart) without
    // crashing the process; the pool replaces broken clients lazily.
    globalThis.__wacrmPgPool.on('error', (err) => {
      console.error('[db] idle client error', err.message);
    });
  }
  return globalThis.__wacrmPgPool;
}
