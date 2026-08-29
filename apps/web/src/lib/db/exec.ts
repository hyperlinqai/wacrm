import 'server-only';
import type { PoolClient } from 'pg';
import { getPool } from './pool';

export type DbRole = 'anon' | 'authenticated' | 'service_role';

export interface RlsContext {
  role: DbRole;
  /** JWT claims exposed to RLS via request.jwt.claims (sub, email, role…). */
  claims?: Record<string, unknown>;
}

export const ANON_CONTEXT: RlsContext = { role: 'anon' };
export const SERVICE_CONTEXT: RlsContext = { role: 'service_role' };

export function userContext(userId: string, email?: string | null): RlsContext {
  return {
    role: 'authenticated',
    claims: { sub: userId, role: 'authenticated', ...(email ? { email } : {}) },
  };
}

/**
 * Run `fn` inside a transaction whose role + request.jwt.claims match the
 * caller's session, so every existing RLS policy (auth.uid(), auth.role())
 * behaves exactly as it did under PostgREST.
 */
export async function withRls<T>(
  ctx: RlsContext,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    // BEGIN + SET LOCAL role + set_config used to be three separate
    // awaited round trips before every single query in the app — each
    // one paying full network latency to the DB. Sent together as one
    // multi-statement string (Postgres' simple query protocol runs
    // ';'-separated statements in a single round trip), it's one. Role
    // names are a closed enum — safe to interpolate. set_config's value
    // can't use a bind parameter here (simple query protocol doesn't
    // support them), so it's embedded via escapeLiteral instead, the
    // same safety property a parameterized query gives.
    const claims = ctx.claims ?? { role: ctx.role };
    const claimsLiteral = client.escapeLiteral(JSON.stringify(claims));
    await client.query(
      `BEGIN; SET LOCAL role ${ctx.role}; SELECT set_config('request.jwt.claims', ${claimsLiteral}, true);`,
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection may already be gone */
    }
    throw err;
  } finally {
    client.release();
  }
}
