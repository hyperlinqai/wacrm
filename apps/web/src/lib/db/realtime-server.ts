import 'server-only';
import { Client } from 'pg';
import { withRls, type RlsContext } from './exec';
import { getTableInfo } from './schema';
import type { RealtimeEventType } from './types';

// Replaces Supabase Realtime's postgres_changes: migration 040 attaches
// pg_notify triggers to the subscribed tables; this module holds one
// LISTEN connection per server process and fans events out to SSE
// subscribers. INSERT/UPDATE rows are refetched under each subscriber's
// own RLS context, so live events leak nothing RLS would hide.

const SUBSCRIBABLE_TABLES = new Set([
  'messages',
  'conversations',
  'notifications',
  'member_presence',
  'message_reactions',
]);

export interface Binding {
  event: RealtimeEventType | '*';
  table: string;
  /** PostgREST-style filter, e.g. "account_id=eq.<uuid>" */
  filter?: string;
}

export interface OutgoingEvent {
  table: string;
  eventType: RealtimeEventType;
  commit_timestamp: string;
  new: Record<string, unknown>;
  old: Record<string, unknown>;
}

interface Subscriber {
  id: number;
  bindings: Binding[];
  ctx: RlsContext;
  send: (event: OutgoingEvent) => void;
}

interface NotifyPayload {
  table: string;
  op: RealtimeEventType;
  keys: Record<string, string>;
}

declare global {
  var __wacrmRealtime: RealtimeHub | undefined;
}

class RealtimeHub {
  private subscribers = new Map<number, Subscriber>();
  private nextId = 1;
  private listener: Client | null = null;
  private connecting: Promise<void> | null = null;
  private stopped = false;

  async subscribe(
    bindings: Binding[],
    ctx: RlsContext,
    send: (event: OutgoingEvent) => void,
  ): Promise<() => void> {
    for (const b of bindings) {
      if (!SUBSCRIBABLE_TABLES.has(b.table)) {
        throw new Error(`Table "${b.table}" is not enabled for realtime`);
      }
    }
    await this.ensureListener();
    const id = this.nextId++;
    this.subscribers.set(id, { id, bindings, ctx, send });
    return () => {
      this.subscribers.delete(id);
    };
  }

  private async ensureListener(): Promise<void> {
    if (this.listener) return;
    if (!this.connecting) {
      this.connecting = this.connect().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  private async connect(): Promise<void> {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    await client.query('LISTEN wacrm_changes');
    client.on('notification', (msg) => {
      if (msg.channel !== 'wacrm_changes' || !msg.payload) return;
      try {
        this.dispatch(JSON.parse(msg.payload) as NotifyPayload);
      } catch (err) {
        console.error('[realtime] bad notify payload', err);
      }
    });
    client.on('error', (err) => {
      console.error('[realtime] listener error, reconnecting', err.message);
      this.reconnect();
    });
    client.on('end', () => {
      if (!this.stopped) this.reconnect();
    });
    this.listener = client;
  }

  private reconnect() {
    this.listener?.removeAllListeners();
    this.listener = null;
    if (this.subscribers.size === 0) return;
    setTimeout(() => {
      this.ensureListener().catch((err) =>
        console.error('[realtime] reconnect failed', err.message),
      );
    }, 2000);
  }

  private dispatch(payload: NotifyPayload) {
    for (const sub of this.subscribers.values()) {
      const matching = sub.bindings.filter(
        (b) =>
          b.table === payload.table &&
          (b.event === '*' || b.event === payload.op) &&
          matchesFilter(b.filter, payload.keys),
      );
      if (matching.length === 0) continue;
      void this.deliver(sub, payload).catch((err) =>
        console.error('[realtime] deliver failed', (err as Error).message),
      );
    }
  }

  private async deliver(sub: Subscriber, payload: NotifyPayload) {
    const timestamp = new Date().toISOString();
    if (payload.op === 'DELETE') {
      sub.send({
        table: payload.table,
        eventType: 'DELETE',
        commit_timestamp: timestamp,
        new: {},
        old: payload.keys,
      });
      return;
    }
    // Refetch under the subscriber's RLS context; invisible rows are
    // silently dropped (matches Supabase Realtime's RLS behaviour).
    const row = await this.fetchRow(sub.ctx, payload.table, payload.keys);
    if (!row) return;
    sub.send({
      table: payload.table,
      eventType: payload.op,
      commit_timestamp: timestamp,
      new: row,
      old: payload.op === 'UPDATE' ? payload.keys : {},
    });
  }

  private async fetchRow(
    ctx: RlsContext,
    table: string,
    keys: Record<string, string>,
  ): Promise<Record<string, unknown> | null> {
    const info = await getTableInfo(table);
    const pk = info.primaryKey.length > 0 ? info.primaryKey : ['id'];
    const values: string[] = [];
    const conds = pk.map((col, i) => {
      const v = keys[col];
      if (v === undefined) throw new Error(`notify payload missing pk "${col}" for ${table}`);
      values.push(v);
      return `"${col}" = $${i + 1}`;
    });
    return withRls(ctx, async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM "${table}" WHERE ${conds.join(' AND ')} LIMIT 1`,
        values,
      );
      return rows[0] ?? null;
    });
  }
}

/** "col=eq.value" — the only filter form the app uses. */
function matchesFilter(filter: string | undefined, keys: Record<string, string>): boolean {
  if (!filter) return true;
  const m = filter.match(/^([a-zA-Z_][a-zA-Z0-9_]*)=eq\.(.*)$/);
  if (!m) return false;
  const actual = keys[m[1]];
  // Unknown key (column not in the routing payload) → err on delivering;
  // the RLS refetch still guards visibility.
  return actual === undefined || actual === m[2];
}

export function getRealtimeHub(): RealtimeHub {
  if (!globalThis.__wacrmRealtime) globalThis.__wacrmRealtime = new RealtimeHub();
  return globalThis.__wacrmRealtime;
}
