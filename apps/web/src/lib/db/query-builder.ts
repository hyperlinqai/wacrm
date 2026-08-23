/* eslint-disable @typescript-eslint/no-explicit-any */
// Chainable, thenable query builder mirroring the subset of the
// supabase-js/PostgREST API this app uses. It only RECORDS the query as a
// serializable descriptor; execution is injected (direct SQL on the
// server, POST /api/db from the browser), so this file must stay
// isomorphic — no Node or DOM dependencies.

import type { FilterStep, QueryDescriptor, QueryResult } from './types';

export type Executor = (q: QueryDescriptor) => Promise<QueryResult>;

// TRow is the row shape (`any` — the app annotates at call sites, as it
// did with the untyped supabase client); TResult tracks list vs single so
// `data` is `any[]` for list queries — array callbacks then get real
// contextual types instead of tripping noImplicitAny.
export class QueryBuilder<TRow = any, TResult = TRow[]>
  implements PromiseLike<QueryResult<TResult>>
{
  private q: QueryDescriptor;
  private exec: Executor;

  constructor(table: string, exec: Executor, descriptor?: QueryDescriptor) {
    this.exec = exec;
    this.q = descriptor ?? { table, action: 'select', filters: [] };
  }

  // ── verbs ─────────────────────────────────────────────────────────
  select(columns = '*', opts?: { count?: 'exact' | 'planned' | 'estimated'; head?: boolean }) {
    if (this.q.action === 'select') {
      this.q.columns = columns;
    } else {
      // .insert()/.update()/.delete().select(...) → RETURNING
      this.q.returning = true;
      this.q.columns = columns;
    }
    if (opts?.count) this.q.count = opts.count;
    if (opts?.head) this.q.head = true;
    return this;
  }

  insert(values: unknown, opts?: { count?: 'exact' }) {
    this.q.action = 'insert';
    this.q.values = values;
    if (opts?.count) this.q.count = opts.count;
    return this;
  }

  upsert(values: unknown, opts?: { onConflict?: string; ignoreDuplicates?: boolean; count?: 'exact' }) {
    this.q.action = 'upsert';
    this.q.values = values;
    this.q.onConflict = opts?.onConflict;
    this.q.ignoreDuplicates = opts?.ignoreDuplicates;
    if (opts?.count) this.q.count = opts.count;
    return this;
  }

  update(values: unknown, opts?: { count?: 'exact' }) {
    this.q.action = 'update';
    this.q.values = values;
    if (opts?.count) this.q.count = opts.count;
    return this;
  }

  delete(opts?: { count?: 'exact' }) {
    this.q.action = 'delete';
    if (opts?.count) this.q.count = opts.count;
    return this;
  }

  // ── filters ───────────────────────────────────────────────────────
  private push(step: FilterStep) {
    this.q.filters.push(step);
    return this;
  }
  eq(column: string, value: unknown) {
    return this.push({ op: 'eq', column, value });
  }
  neq(column: string, value: unknown) {
    return this.push({ op: 'neq', column, value });
  }
  gt(column: string, value: unknown) {
    return this.push({ op: 'gt', column, value });
  }
  gte(column: string, value: unknown) {
    return this.push({ op: 'gte', column, value });
  }
  lt(column: string, value: unknown) {
    return this.push({ op: 'lt', column, value });
  }
  lte(column: string, value: unknown) {
    return this.push({ op: 'lte', column, value });
  }
  like(column: string, pattern: string) {
    return this.push({ op: 'like', column, value: pattern });
  }
  ilike(column: string, pattern: string) {
    return this.push({ op: 'ilike', column, value: pattern });
  }
  is(column: string, value: null | boolean) {
    return this.push({ op: 'is', column, value });
  }
  in(column: string, values: readonly unknown[]) {
    return this.push({ op: 'in', column, value: [...values] });
  }
  contains(column: string, value: unknown) {
    return this.push({ op: 'contains', column, value });
  }
  overlaps(column: string, value: readonly unknown[]) {
    return this.push({ op: 'overlaps', column, value: [...value] });
  }
  not(column: string, operator: string, value: unknown) {
    return this.push({ op: 'not', column, operator, value });
  }
  /** PostgREST boolean expression, e.g. "status.eq.open,unread_count.gt.0" */
  or(expression: string, opts?: { referencedTable?: string }) {
    if (opts?.referencedTable) {
      throw new Error('or() with referencedTable is not supported by the pg adapter');
    }
    return this.push({ op: 'or', value: expression });
  }
  filter(column: string, operator: string, value: unknown) {
    return this.push({ op: 'raw', column, operator, value });
  }
  match(query: Record<string, unknown>) {
    for (const [column, value] of Object.entries(query)) this.eq(column, value);
    return this;
  }

  // ── modifiers ─────────────────────────────────────────────────────
  order(
    column: string,
    opts?: { ascending?: boolean; nullsFirst?: boolean; referencedTable?: string },
  ) {
    (this.q.order ??= []).push({
      column,
      ascending: opts?.ascending ?? true,
      nullsFirst: opts?.nullsFirst,
      referencedTable: opts?.referencedTable,
    });
    return this;
  }
  limit(count: number) {
    this.q.limit = count;
    return this;
  }
  range(from: number, to: number) {
    this.q.offset = from;
    this.q.rangeEnd = to;
    return this;
  }
  single(): QueryBuilder<TRow, TRow> {
    this.q.single = 'single';
    return this as unknown as QueryBuilder<TRow, TRow>;
  }
  maybeSingle(): QueryBuilder<TRow, TRow | null> {
    this.q.single = 'maybeSingle';
    return this as unknown as QueryBuilder<TRow, TRow | null>;
  }
  /** No-op provided for API compatibility. */
  throwOnError() {
    return this;
  }

  // ── execution ─────────────────────────────────────────────────────
  then<R1 = QueryResult<TResult>, R2 = never>(
    onfulfilled?: ((value: QueryResult<TResult>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.exec(this.q).then(
      onfulfilled as ((value: QueryResult) => R1 | PromiseLike<R1>) | null | undefined,
      onrejected,
    );
  }
}

export function makeRpcDescriptor(fn: string, args?: Record<string, unknown>): QueryDescriptor {
  return { table: fn, action: 'rpc', values: args ?? {}, filters: [] };
}
