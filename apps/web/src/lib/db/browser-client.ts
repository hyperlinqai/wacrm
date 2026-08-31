'use client';

// Browser-side drop-in for the supabase-js client. Queries are shipped as
// serialized descriptors to /api/db, where they run under the session's
// RLS context; auth talks to /api/auth/*; realtime rides an SSE stream.

import { QueryBuilder, makeRpcDescriptor } from '@wacrm/shared/db/query-builder';
import type { SupabaseClient } from '@wacrm/shared/db/client-types';
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
} from '@wacrm/shared/db/types';

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res.json()) as T;
}

function networkErrorResult(err: unknown): QueryResult {
  return {
    data: null,
    error: Object.assign(new Error((err as Error)?.message ?? 'Network error'), {
      code: 'FETCH_ERROR',
      details: '',
      hint: '',
    }),
    count: null,
    status: 0,
    statusText: 'Network error',
  };
}

/** Server-side cap on descriptors per request — see app/api/db/route.ts. */
const MAX_BATCH = 25;

interface QueuedQuery {
  q: QueryDescriptor;
  /** Always resolved, never rejected — a failure becomes a QueryResult. */
  resolve: (result: QueryResult) => void;
}

let queue: QueuedQuery[] = [];
let flushScheduled = false;

/**
 * Queries issued in the same tick travel in one request.
 *
 * Every /api/db POST costs a round trip, an `auth.users` lookup to check
 * the session, and a pooled transaction. Only the last of those is
 * inherent to the query: the contacts page opens with four independent
 * effects, which meant four round trips and four identical session
 * lookups before a single row came back. React runs a commit's effects
 * in one task, so a microtask flush catches all of them — no timer, no
 * added latency for a query that turns out to be alone.
 *
 * Sequencing is untouched. Only work the caller already had in flight
 * concurrently ends up in a batch; anything behind an `await` lands in a
 * later one, so a read that follows a write still sees the write.
 */
function enqueue(q: QueryDescriptor): Promise<QueryResult> {
  return new Promise<QueryResult>((resolve) => {
    queue.push({ q, resolve });
    if (flushScheduled) return;
    flushScheduled = true;
    queueMicrotask(flush);
  });
}

function flush() {
  flushScheduled = false;
  const batch = queue;
  queue = [];
  for (let i = 0; i < batch.length; i += MAX_BATCH) {
    void send(batch.slice(i, i + MAX_BATCH));
  }
}

async function send(chunk: QueuedQuery[]) {
  try {
    // A lone query keeps the original single-descriptor body, so the
    // common case is byte-for-byte the request it always was.
    const body = chunk.length === 1 ? chunk[0].q : chunk.map((item) => item.q);
    const res = await fetch('/api/db', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as QueryResult | QueryResult[];

    if (chunk.length === 1) {
      chunk[0].resolve(json as QueryResult);
      return;
    }
    // A batch that comes back the wrong shape (a proxy error page, a
    // server that predates batching) must not resolve queries with each
    // other's rows.
    if (!Array.isArray(json) || json.length !== chunk.length) {
      throw new Error('Malformed batch response');
    }
    chunk.forEach((item, index) => item.resolve(json[index]));
  } catch (err) {
    for (const item of chunk) item.resolve(networkErrorResult(err));
  }
}

// Reads that are in flight are shared rather than repeated. Nothing here
// caches across time — the entry is dropped the moment the request
// settles — so a query issued after a write still hits the server. It
// only collapses the duplicates a render pass produces: the header and
// the sidebar both count unread notifications on mount, and every page
// re-asks for the same account/profile rows, each of which otherwise
// costs a descriptor in the batch and a pooled SQL transaction of its own.
const inFlightReads = new Map<string, Promise<QueryResult>>();

function cloneResult(result: QueryResult): QueryResult {
  // Each caller gets its own rows, so one component sorting or mutating
  // a list in place can't corrupt another's copy of a shared response.
  return { ...result, data: result.data === null ? null : structuredClone(result.data) };
}

function execOnServer(q: QueryDescriptor): Promise<QueryResult> {
  // Only selects are safe to collapse; every mutation must reach the server.
  if (q.action !== 'select') return enqueue(q);

  const key = JSON.stringify(q);
  const existing = inFlightReads.get(key);
  if (existing) return existing.then(cloneResult);

  const pending = enqueue(q);
  inFlightReads.set(key, pending);
  void pending.finally(() => {
    if (inFlightReads.get(key) === pending) inFlightReads.delete(key);
  });
  return pending;
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

/** One `postgres_changes` event as `/api/realtime` puts it on the wire. */
interface WireEvent {
  table: string;
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  commit_timestamp: string;
  new: Record<string, unknown>;
  old: Record<string, unknown>;
}

/** Server-side cap on bindings per stream — see app/api/realtime/route.ts. */
const MAX_BINDINGS_PER_STREAM = 20;

/** How long to wait for the mount/unmount burst of a navigation to settle
 *  before reconciling the stream, so one route change costs one reconnect. */
const RESYNC_DEBOUNCE_MS = 50;

/**
 * One EventSource for the whole tab — NOT one per channel.
 *
 * Browsers cap concurrent HTTP/1.1 connections at six per origin, and an
 * SSE stream holds its connection for as long as it lives. A channel per
 * stream put the dashboard at four before you opened anything (sidebar
 * unread, sidebar notifications, header notifications, presence) and the
 * inbox took it to six — at which point every /api/db POST, RSC
 * navigation and script chunk queued behind a response that never ends
 * and the app stopped loading altogether.
 *
 * Channels are therefore bookkeeping only. The hub merges their bindings
 * into one de-duplicated subscription list, keeps a single stream open
 * for it, and fans each event back out to whichever channels asked for
 * that table. It also collapses the server's work: the route refetches
 * every row once per subscriber under that subscriber's RLS context, so
 * six streams meant six refetches per event and now there is one.
 */
class RealtimeHub {
  private channels = new Set<BrowserChannel>();
  private sources: EventSource[] = [];
  /** Serialized subscription list currently on the wire; '' when closed. */
  private currentKey = '';
  private open = false;
  private resyncTimer: ReturnType<typeof setTimeout> | null = null;

  add(channel: BrowserChannel) {
    this.channels.add(channel);
    // A channel whose bindings are already covered by the live stream
    // triggers no reconnect, so it would never see an `onopen`. Tell it
    // directly that it is live.
    if (this.open) channel.announce('SUBSCRIBED');
    this.scheduleResync();
  }

  remove(channel: BrowserChannel) {
    this.channels.delete(channel);
    this.scheduleResync();
  }

  private scheduleResync() {
    if (this.resyncTimer) return;
    this.resyncTimer = setTimeout(() => {
      this.resyncTimer = null;
      this.resync();
    }, RESYNC_DEBOUNCE_MS);
  }

  private resync() {
    const subs = this.mergedSubs();
    const key = JSON.stringify(subs);
    if (key === this.currentKey) return;
    this.currentKey = key;
    this.closeSources();
    if (subs.length === 0) return;

    // Normally a single stream. A binding set past the route's limit
    // spills into another rather than failing the request outright and
    // taking every subscription down with it.
    for (let i = 0; i < subs.length; i += MAX_BINDINGS_PER_STREAM) {
      const chunk = subs.slice(i, i + MAX_BINDINGS_PER_STREAM);
      const source = new EventSource(
        `/api/realtime?subs=${encodeURIComponent(JSON.stringify(chunk))}`,
      );
      source.onopen = () => {
        this.open = true;
        this.announce('SUBSCRIBED');
      };
      source.onerror = () => {
        // EventSource reconnects on its own; only a channel that never
        // came up needs to hear about the failure.
        this.announce('CHANNEL_ERROR', new Error('realtime stream failed'));
      };
      source.onmessage = (msg) => this.dispatch(msg.data as string);
      this.sources.push(source);
    }
  }

  /** Every subscribed channel's bindings, de-duplicated. */
  private mergedSubs(): { event: string; table: string; filter?: string }[] {
    const seen = new Map<string, { event: string; table: string; filter?: string }>();
    for (const channel of this.channels) {
      for (const b of channel.bindings) {
        seen.set(`${b.filter.event}|${b.filter.table}|${b.filter.filter ?? ''}`, {
          event: b.filter.event,
          table: b.filter.table,
          filter: b.filter.filter,
        });
      }
    }
    return [...seen.values()];
  }

  private announce(status: ChannelStatus, err?: Error) {
    for (const channel of this.channels) channel.announce(status, err);
  }

  private dispatch(data: string) {
    if (!data) return;
    let event: WireEvent;
    try {
      event = JSON.parse(data) as WireEvent;
    } catch {
      return;
    }
    for (const channel of this.channels) channel.deliver(event);
  }

  private closeSources() {
    for (const source of this.sources) source.close();
    this.sources = [];
    this.open = false;
  }
}

const realtimeHub = new RealtimeHub();

class BrowserChannel implements RealtimeChannel {
  readonly bindings: Binding[] = [];
  private statusCb?: (status: ChannelStatus, err?: Error) => void;
  private announced = false;
  private joined = false;

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
    if (!this.joined) {
      this.joined = true;
      realtimeHub.add(this);
    }
    return this;
  }

  /** Hub → channel: the shared stream opened, or failed to. Reported once. */
  announce(status: ChannelStatus, err?: Error) {
    if (this.announced) return;
    this.announced = true;
    this.statusCb?.(status, err);
  }

  /** Hub → channel: route one event to the bindings that asked for it. */
  deliver(event: WireEvent) {
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
  }

  async unsubscribe(): Promise<'ok' | 'error'> {
    if (this.joined) {
      this.joined = false;
      realtimeHub.remove(this);
    }
    this.announced = false;
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
            const base = typeof window !== 'undefined'
              ? window.location.origin
              : (process.env.NEXT_PUBLIC_SITE_URL ?? '');
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
