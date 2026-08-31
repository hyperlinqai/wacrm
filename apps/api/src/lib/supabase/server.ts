import { cookies } from 'next/headers';
import { makeServerClient } from '@/lib/db/server-client';
import { SESSION_COOKIE, sessionCookieOptions } from '@/lib/db/jwt';
import type { SupabaseClient } from '@/lib/db';

// Server data client — direct Postgres under the session's RLS context.
// The session JWT lives in an httpOnly cookie.
export async function createClient(): Promise<SupabaseClient> {
  const cookieStore = await cookies();
  return makeServerClient({
    getToken: () => cookieStore.get(SESSION_COOKIE)?.value,
    setToken: (token) => {
      try {
        cookieStore.set(SESSION_COOKIE, token, sessionCookieOptions());
      } catch {
        // Called from a Server Component — the proxy handles renewal there.
      }
    },
    clearToken: () => {
      try {
        cookieStore.set(SESSION_COOKIE, '', { ...sessionCookieOptions(), maxAge: 0 });
      } catch {
        /* same as above */
      }
    },
  });
}
