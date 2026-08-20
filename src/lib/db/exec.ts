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
    await client.query('BEGIN');
    // Role names are a closed enum — safe to interpolate.
    await client.query(`SET LOCAL role ${ctx.role}`);
    const claims = ctx.claims ?? { role: ctx.role };
    await client.query('SELECT set_config($1, $2, true)', [
      'request.jwt.claims',
      JSON.stringify(claims),
    ]);
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
