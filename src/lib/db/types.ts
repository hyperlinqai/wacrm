/* eslint-disable @typescript-eslint/no-explicit-any */
// Public types for the direct-Postgres data layer. Shape-compatible with
// the subset of @supabase/supabase-js the app was written against, so the
// 160+ call sites keep compiling after the import codemod.

export interface User {
  id: string;
  email?: string;
  user_metadata: Record<string, unknown>;
  app_metadata: Record<string, unknown>;
  created_at?: string;
  aud?: string;
  role?: string;
}

export interface Session {
  user: User;
  access_token: string;
  expires_at?: number;
}

export interface PostgrestError extends Error {
  message: string;
  details: string;
  hint: string;
  code: string;
}

export interface AuthError {
  message: string;
  status?: number;
  code?: string;
}

export interface AuthResult {
  data: { user: User | null; session: Session | null };
  error: AuthError | null;
}

export type RealtimeEventType = 'INSERT' | 'UPDATE' | 'DELETE';

export interface PostgresChangePayload<T = any> {
  schema: string;
  table: string;
  eventType: RealtimeEventType;
  commit_timestamp: string;
  new: T;
  old: Partial<T>;
  errors: null;
}

export interface PostgresChangesFilter {
  event: RealtimeEventType | '*';
  schema: string;
  table: string;
  filter?: string;
}

export type ChannelStatus = 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED';

export interface RealtimeChannel {
  on(
    type: 'postgres_changes',
    filter: PostgresChangesFilter,
    callback: (payload: PostgresChangePayload) => void,
  ): RealtimeChannel;
  subscribe(callback?: (status: ChannelStatus, err?: Error) => void): RealtimeChannel;
  unsubscribe(): Promise<'ok' | 'error'>;
}

/** Serializable query descriptor — built isomorphically, executed on the server. */
export interface QueryDescriptor {
  table: string;
  action: 'select' | 'insert' | 'update' | 'upsert' | 'delete' | 'rpc';
  columns?: string; // select string, possibly with embedded resources
  values?: unknown; // insert/update/upsert payload, or rpc args
  filters: FilterStep[];
  order?: { column: string; ascending: boolean; nullsFirst?: boolean; referencedTable?: string }[];
  limit?: number;
  offset?: number;
  rangeEnd?: number;
  single?: 'single' | 'maybeSingle';
  count?: 'exact' | 'planned' | 'estimated';
  head?: boolean;
  onConflict?: string;
  ignoreDuplicates?: boolean;
  returning?: boolean; // whether .select() follows a mutation
}

export type FilterOp =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'like'
  | 'ilike'
  | 'is'
  | 'in'
  | 'contains'
  | 'containedBy'
  | 'overlaps'
  | 'not'
  | 'or'
  | 'raw'
  | 'match';

export interface FilterStep {
  op: FilterOp;
  column?: string;
  value?: unknown;
  /** for `not`/`raw`: the inner operator name; unused otherwise */
  operator?: string;
}

export interface QueryResult<T = any> {
  data: T | null;
  error: PostgrestError | null;
  count: number | null;
  status: number;
  statusText: string;
}
