'use client';

// Browser-side drop-in for the supabase-js client. Queries are shipped as
// serialized descriptors to /api/db, where they run under the session's
// RLS context; auth talks to /api/auth/*; realtime rides an SSE stream.

import { QueryBuilder, makeRpcDescriptor } from './query-builder';
import type { SupabaseClient } from './client-types';
import type {
  AuthResult,
  ChannelStatus,
  PostgresChangePayload,
  PostgresChangesFilter,
  QueryDescriptor,
  QueryResult,
  RealtimeChannel,
  Session,
  User,
} from './types';

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res.json()) as T;
}

async function execOnServer(q: QueryDescriptor): Promise<QueryResult> {
  try {
    return await postJson<QueryResult>('/api/db', q);
  } catch (err) {
    return {
      data: null,
      error: Object.assign(new Error((err as Error).message ?? 'Network error'), {
        code: 'FETCH_ERROR',
        details: '',
        hint: '',
      }),
      count: null,
      status: 0,
      statusText: 'Network error',
    };
  }
}

// ── auth ──────────────────────────────────────────────────────────────

type AuthListener = (event: string, session: Session | null) => void;

const listeners = new Set<AuthListener>();
let cachedSession: Session | null | undefined;

function emit(event: string, session: Session | null) {
  cachedSession = session;
  for (const cb of listeners) cb(event, session);
}

async function fetchSession(): Promise<Session | null> {
  try {
    const res = await fetch('/api/auth/user');
    const json = (await res.json()) as { user: User | null };
    cachedSession = json.user ? ({ user: json.user, access_token: '' } as Session) : null;
    return cachedSession;
  } catch {
    return cachedSession ?? null;
  }
}

// ── realtime ──────────────────────────────────────────────────────────

interface Binding {
  filter: PostgresChangesFilter;
  callback: (payload: PostgresChangePayload) => void;
}

class BrowserChannel implements RealtimeChannel {
  private bindings: Binding[] = [];
  private source: EventSource | null = null;
  private statusCb?: (status: ChannelStatus, err?: Error) => void;
  private announced = false;

  constructor(readonly name: string) {}

  on(
    _type: 'postgres_changes',
    filter: PostgresChangesFilter,
    callback: (payload: PostgresChangePayload) => void,
  ): RealtimeChannel {
    this.bindings.push({ filter, callback });
    return this;
  }

  subscribe(callback?: (status: ChannelStatus, err?: Error) => void): RealtimeChannel {
    this.statusCb = callback;
    const subs = this.bindings.map((b) => ({
      event: b.filter.event,
      table: b.filter.table,
      filter: b.filter.filter,
    }));
    const url = `/api/realtime?subs=${encodeURIComponent(JSON.stringify(subs))}`;
    this.source = new EventSource(url);
    this.source.onopen = () => {
      if (!this.announced) {
        this.announced = true;
        this.statusCb?.('SUBSCRIBED');
      }
    };
    this.source.onerror = () => {
      // EventSource retries automatically; surface the first failure only.
      if (!this.announced) {
        this.announced = true;
        this.statusCb?.('CHANNEL_ERROR', new Error('realtime stream failed'));
      }
    };
    this.source.onmessage = (msg) => {
      if (!msg.data) return;
      let event: {
        table: string;
        eventType: 'INSERT' | 'UPDATE' | 'DELETE';
        commit_timestamp: string;
        new: Record<string, unknown>;
        old: Record<string, unknown>;
      };
      try {
        event = JSON.parse(msg.data);
      } catch {
        return;
      }
      for (const b of this.bindings) {
        if (b.filter.table !== event.table) continue;
        if (b.filter.event !== '*' && b.filter.event !== event.eventType) continue;
        if (!clientFilterMatches(b.filter.filter, event)) continue;
        b.callback({
          schema: 'public',
          table: event.table,
          eventType: event.eventType,
          commit_timestamp: event.commit_timestamp,
          new: event.new,
          old: event.old,
          errors: null,
        });
      }
    };
    return this;
  }

  async unsubscribe(): Promise<'ok' | 'error'> {
    this.source?.close();
    this.source = null;
    this.statusCb?.('CLOSED');
    return 'ok';
  }
}

function clientFilterMatches(
  filter: string | undefined,
  event: { eventType: string; new: Record<string, unknown>; old: Record<string, unknown> },
): boolean {
  if (!filter) return true;
  const m = filter.match(/^([a-zA-Z_][a-zA-Z0-9_]*)=eq\.(.*)$/);
  if (!m) return true;
  const row = event.eventType === 'DELETE' ? event.old : event.new;
  const value = row[m[1]];
  return value === undefined || String(value) === m[2];
}

// ── client factory ────────────────────────────────────────────────────

export function makeBrowserClient(): SupabaseClient {
  return {
    from(table: string) {
      return new QueryBuilder(table, execOnServer);
    },
    rpc(fn: string, args?: Record<string, unknown>) {
      return new QueryBuilder(fn, execOnServer, makeRpcDescriptor(fn, args));
    },
    auth: {
      async getUser() {
        const session = await fetchSession();
        return { data: { user: session?.user ?? null }, error: null };
      },
      async getSession() {
        const session =
          cachedSession !== undefined ? cachedSession : await fetchSession();
        return { data: { session }, error: null };
      },
      async signInWithPassword(credentials) {
        const result = await postJson<AuthResult>('/api/auth/login', credentials);
        if (result.data?.session) emit('SIGNED_IN', result.data.session);
        return result;
      },
      async signUp(credentials) {
        const result = await postJson<AuthResult>('/api/auth/signup', {
          email: credentials.email,
          password: credentials.password,
          data: credentials.options?.data ?? {},
        });
        if (result.data?.session) emit('SIGNED_IN', result.data.session);
        return result;
      },
      async signOut(options) {
        await postJson('/api/auth/logout', { scope: options?.scope ?? 'local' });
        emit('SIGNED_OUT', null);
        return { error: null };
      },
      async updateUser(attrs) {
        return postJson('/api/auth/update', attrs);
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
      onAuthStateChange(callback) {
        listeners.add(callback);
        // Mimic supabase's INITIAL_SESSION emission.
        void fetchSession().then((session) => callback('INITIAL_SESSION', session));
        return {
          data: {
            subscription: {
              unsubscribe() {
                listeners.delete(callback);
              },
            },
          },
        };
      },
    },
    storage: {
      from(bucket: string) {
        return {
          async upload(
            path: string,
            body: Blob | ArrayBuffer | Uint8Array | Buffer | File,
            opts?: { contentType?: string; upsert?: boolean; cacheControl?: string },
          ) {
            const form = new FormData();
            form.set('bucket', bucket);
            form.set('path', path);
            form.set('upsert', String(opts?.upsert ?? false));
            const blob =
              body instanceof Blob
                ? body
                : new Blob([body as ArrayBuffer], { type: opts?.contentType });
            form.set(
              'file',
              new File([blob], 'upload', {
                type: opts?.contentType ?? (body instanceof Blob ? body.type : ''),
              }),
            );
            const res = await fetch('/api/storage/upload', { method: 'POST', body: form });
            return (await res.json()) as {
              data: { path: string } | null;
              error: { message: string; statusCode?: string } | null;
            };
          },
          getPublicUrl(path: string) {
            const base = process.env.NEXT_PUBLIC_SITE_URL ?? '';
            return { data: { publicUrl: `${base}/api/storage/object/public/${bucket}/${path}` } };
          },
          async remove(paths: string[]) {
            return postJson('/api/storage/remove', { bucket, paths });
          },
        };
      },
    },
    channel(name: string) {
      return new BrowserChannel(name);
    },
    async removeChannel(channel: RealtimeChannel) {
      return channel.unsubscribe();
    },
  };
}
