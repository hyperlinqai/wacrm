import 'server-only';
import { QueryBuilder, makeRpcDescriptor } from './query-builder';
import { executeDescriptor } from './sql-compiler';
import { ANON_CONTEXT, SERVICE_CONTEXT, userContext, type RlsContext } from './exec';
import {
  AuthApiError,
  getSessionUser,
  revokeAllSessions,
  signInWithPassword as doSignIn,
  signUp as doSignUp,
  updateUser as doUpdateUser,
} from './auth-server';
import { makeStorageFacade } from './storage-server';
import type { SupabaseClient } from './client-types';
import type { AuthError, Session, User } from './types';

// Server-side drop-in for the supabase-js client: queries run directly
// against Postgres under the session's RLS context.

function authError(err: unknown): AuthError {
  if (err instanceof AuthApiError) {
    return { message: err.message, status: err.status, code: err.code };
  }
  return { message: (err as Error).message ?? 'Internal error', status: 500 };
}

export interface CookieAdapter {
  getToken(): string | undefined;
  setToken(token: string): void;
  clearToken(): void;
}

export function makeServerClient(cookies: CookieAdapter): SupabaseClient {
  let resolved: { user: User; token: string } | null | undefined;

  async function resolveUser(): Promise<{ user: User; token: string } | null> {
    if (resolved !== undefined) return resolved;
    const token = cookies.getToken();
    const session = await getSessionUser(token);
    resolved = session && token ? { user: session.user, token } : null;
    return resolved;
  }

  async function currentContext(): Promise<RlsContext> {
    const session = await resolveUser();
    return session ? userContext(session.user.id, session.user.email) : ANON_CONTEXT;
  }

  const exec = async (q: Parameters<typeof executeDescriptor>[1]) =>
    executeDescriptor(await currentContext(), q);

  const client: SupabaseClient = {
    from(table: string) {
      return new QueryBuilder(table, exec);
    },
    rpc(fn: string, args?: Record<string, unknown>) {
      return new QueryBuilder(fn, exec, makeRpcDescriptor(fn, args));
    },
    auth: {
      async getUser() {
        const session = await resolveUser();
        return session
          ? { data: { user: session.user }, error: null }
          : { data: { user: null }, error: null };
      },
      async getSession() {
        const session = await resolveUser();
        return {
          data: {
            session: session
              ? ({ user: session.user, access_token: session.token } as Session)
              : null,
          },
          error: null,
        };
      },
      async signInWithPassword({ email, password }) {
        try {
          const session = await doSignIn(email, password);
          cookies.setToken(session.access_token);
          resolved = { user: session.user, token: session.access_token };
          return { data: { user: session.user, session }, error: null };
        } catch (err) {
          return { data: { user: null, session: null }, error: authError(err) };
        }
      },
      async signUp({ email, password, options }) {
        try {
          const session = await doSignUp(email, password, options?.data ?? {});
          cookies.setToken(session.access_token);
          resolved = { user: session.user, token: session.access_token };
          return { data: { user: session.user, session }, error: null };
        } catch (err) {
          return { data: { user: null, session: null }, error: authError(err) };
        }
      },
      async signOut(options) {
        const session = await resolveUser();
        if (session && options?.scope === 'global') {
          await revokeAllSessions(session.user.id);
        }
        cookies.clearToken();
        resolved = null;
        return { error: null };
      },
      async updateUser(attrs) {
        const session = await resolveUser();
        if (!session) {
          return {
            data: { user: null },
            error: { message: 'Auth session missing!', status: 401 },
          };
        }
        try {
          const user = await doUpdateUser(session.user.id, attrs);
          resolved = { user, token: session.token };
          return { data: { user }, error: null };
        } catch (err) {
          return { data: { user: null }, error: authError(err) };
        }
      },
      async resetPasswordForEmail() {
        return {
          data: null,
          error: {
            message:
              'Password reset emails are not available on this deployment. Ask a workspace owner to set a new password for you.',
            status: 501,
          },
        };
      },
      onAuthStateChange() {
        // Server components never subscribe; keep the shape for parity.
        return { data: { subscription: { unsubscribe() {} } } };
      },
    },
    get storage() {
      // Storage authorization needs the resolved user; build lazily with a
      // context that resolves per call.
      return {
        from: (bucket: string) => ({
          upload: async (
            path: string,
            body: Blob | ArrayBuffer | Uint8Array | Buffer,
            opts?: { contentType?: string; upsert?: boolean; cacheControl?: string },
          ) => makeStorageFacade(await currentContext()).from(bucket).upload(path, body, opts),
          getPublicUrl: (path: string) =>
            makeStorageFacade(ANON_CONTEXT).from(bucket).getPublicUrl(path),
          remove: async (paths: string[]) =>
            makeStorageFacade(await currentContext()).from(bucket).remove(paths),
        }),
      };
    },
    channel() {
      throw new Error('Realtime channels are browser-only');
    },
    async removeChannel() {
      return 'ok';
    },
  };
  return client;
}

/** Service-role client (RLS bypass) for webhooks / automations / flows. */
export function makeAdminClient(): SupabaseClient {
  const exec = (q: Parameters<typeof executeDescriptor>[1]) =>
    executeDescriptor(SERVICE_CONTEXT, q);
  return {
    from(table: string) {
      return new QueryBuilder(table, exec);
    },
    rpc(fn: string, args?: Record<string, unknown>) {
      return new QueryBuilder(fn, exec, makeRpcDescriptor(fn, args));
    },
    auth: {
      async getUser() {
        return { data: { user: null }, error: null };
      },
      async getSession() {
        return { data: { session: null }, error: null };
      },
      async signInWithPassword() {
        throw new Error('Admin client cannot sign in');
      },
      async signUp() {
        throw new Error('Admin client cannot sign up');
      },
      async signOut() {
        return { error: null };
      },
      async updateUser() {
        throw new Error('Admin client cannot update users');
      },
      async resetPasswordForEmail() {
        throw new Error('Admin client cannot reset passwords');
      },
      onAuthStateChange() {
        return { data: { subscription: { unsubscribe() {} } } };
      },
    },
    storage: makeStorageFacade(SERVICE_CONTEXT),
    channel() {
      throw new Error('Realtime channels are browser-only');
    },
    async removeChannel() {
      return 'ok';
    },
  };
}
