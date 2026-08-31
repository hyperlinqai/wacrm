import 'server-only';
import { Pool } from 'pg';

// Single shared pool per server process. DATABASE_URL should be a role
// that is a member of anon / authenticated / service_role (e.g. the
// `authenticator` role) — every query runs inside a transaction that
// downgrades to the JWT role via SET LOCAL, so RLS applies exactly as
// it did under PostgREST.
declare global {
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
      // Defense-in-depth against a connection leaking out of the pool
      // forever: if the process holding a client dies/hangs between
      // `BEGIN`/`SET LOCAL role` and the query that follows (observed in
      // production — a connection sat "idle in transaction" for 30+
      // minutes, permanently occupying a pool slot), Postgres has no way
      // to know unless told — the server's own
      // idle_in_transaction_session_timeout defaults to disabled (0).
      // statement_timeout is the same idea for a query that's genuinely
      // still running rather than abandoned. Every real query in this
      // app is a short RLS-scoped select/insert/update, so both limits
      // are generous relative to normal operation.
      statement_timeout: 30_000,
      idle_in_transaction_session_timeout: 15_000,
    });
    // Surface idle-client errors (e.g. Postgres restart) without
    // crashing the process; the pool replaces broken clients lazily.
    globalThis.__wacrmPgPool.on('error', (err) => {
      console.error('[db] idle client error', err.message);
    });
  }
  return globalThis.__wacrmPgPool;
}
