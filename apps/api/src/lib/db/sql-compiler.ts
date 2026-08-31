import 'server-only';
import type { PoolClient } from 'pg';
import type { DatabaseError } from 'pg';
import { getPool } from './pool';
import { getTableInfo } from './schema';
import { resolveRelationship } from './relationships';
import type { FilterStep, QueryDescriptor, QueryResult, PostgrestError } from '@wacrm/shared/db/types';
import { withRls, type RlsContext } from './exec';

// Compiles a QueryDescriptor into parameterized SQL with PostgREST
// semantics (embedded resources, filter operators, single/maybeSingle,
// counts) and executes it under the caller's RLS context.

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`Invalid identifier: ${JSON.stringify(name)}`);
  return `"${name}"`;
}

class Params {
  values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

// ── select-string parsing ────────────────────────────────────────────

interface ColumnNode {
  kind: 'column';
  name: string;
  alias?: string;
}
interface StarNode {
  kind: 'star';
}
interface EmbedNode {
  kind: 'embed';
  table: string;
  alias: string;
  hint?: string;
  inner: boolean;
  children: SelectNode[];
}
type SelectNode = ColumnNode | StarNode | EmbedNode;

/** Split on commas that are not inside parentheses. */
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

export function parseSelect(select: string): SelectNode[] {
  return splitTopLevel(select).map((part): SelectNode => {
    const parenIdx = part.indexOf('(');
    if (parenIdx === -1) {
      if (part === '*') return { kind: 'star' };
      const [aliasOrName, name] = part.includes(':')
        ? (part.split(':', 2) as [string, string])
        : [undefined, part];
      const colName = (name ?? part).trim();
      if (!IDENT.test(colName)) throw new Error(`Unsupported select item: ${part}`);
      return { kind: 'column', name: colName, alias: aliasOrName?.trim() };
    }
    if (!part.endsWith(')')) throw new Error(`Unbalanced select item: ${part}`);
    let head = part.slice(0, parenIdx).trim();
    const inner = part.slice(parenIdx + 1, -1);
    let alias: string | undefined;
    if (head.includes(':')) {
      const [a, rest] = head.split(':', 2);
      alias = a.trim();
      head = rest.trim();
    }
    let hint: string | undefined;
    let innerJoin = false;
    if (head.includes('!')) {
      const segments = head.split('!');
      head = segments[0].trim();
      for (const seg of segments.slice(1)) {
        if (seg.trim() === 'inner') innerJoin = true;
        else hint = seg.trim();
      }
    }
    if (!IDENT.test(head)) throw new Error(`Unsupported embed: ${part}`);
    return {
      kind: 'embed',
      table: head,
      alias: alias ?? head,
      hint,
      inner: innerJoin,
      children: inner.trim() ? parseSelect(inner) : [{ kind: 'star' }],
    };
  });
}

// ── filter compilation ───────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

function compileOperator(
  qualifiedCol: string,
  op: string,
  value: unknown,
  params: Params,
): string {
  switch (op) {
    case 'eq':
      if (value === null) return `${qualifiedCol} IS NULL`;
      return `${qualifiedCol} = ${params.add(value)}`;
    case 'neq':
      if (value === null) return `${qualifiedCol} IS NOT NULL`;
      return `${qualifiedCol} <> ${params.add(value)}`;
    case 'gt':
      return `${qualifiedCol} > ${params.add(value)}`;
    case 'gte':
      return `${qualifiedCol} >= ${params.add(value)}`;
    case 'lt':
      return `${qualifiedCol} < ${params.add(value)}`;
    case 'lte':
      return `${qualifiedCol} <= ${params.add(value)}`;
    case 'like':
      return `${qualifiedCol} LIKE ${params.add(value)}`;
    case 'ilike':
      return `${qualifiedCol} ILIKE ${params.add(value)}`;
    case 'is':
      if (value === null) return `${qualifiedCol} IS NULL`;
      if (value === true) return `${qualifiedCol} IS TRUE`;
      if (value === false) return `${qualifiedCol} IS FALSE`;
      throw new Error(`Unsupported is() value: ${String(value)}`);
    case 'in': {
      const arr = value as unknown[];
      if (arr.length === 0) return 'false';
      return `${qualifiedCol} = ANY(${params.add(arr)})`;
    }
    case 'cs':
    case 'contains': {
      if (Array.isArray(value)) return `${qualifiedCol} @> ${params.add(value)}`;
      return `${qualifiedCol} @> ${params.add(JSON.stringify(value))}::jsonb`;
    }
    case 'ov':
    case 'overlaps':
      return `${qualifiedCol} && ${params.add(value)}`;
    default:
      throw new Error(`Unsupported filter operator: ${op}`);
  }
}

function qualify(table: string, column: string): string {
  // Dotted columns (embedded-table filters) are handled by the caller;
  // here we only qualify plain columns on the current table. JSON path
  // operators in the column position (PostgREST style) are supported:
  //   payload->>meta_message_id  →  "payload"->>'meta_message_id'
  const jsonMatch = column.match(/^([a-zA-Z_][a-zA-Z0-9_]*)((?:->>?[a-zA-Z0-9_]+)+)$/);
  if (jsonMatch) {
    const path = jsonMatch[2].replace(
      /->(>?)([a-zA-Z0-9_]+)/g,
      (_m, deep, key) => `->${deep}'${key}'`,
    );
    return `${ident(table)}.${ident(jsonMatch[1])}${path}`;
  }
  return `${ident(table)}.${ident(column)}`;
}

/**
 * PostgREST boolean expression, e.g.
 *   "status.eq.open,and(unread_count.gt.0,assigned_agent_id.is.null)"
 * Wildcards `*` in like/ilike patterns become `%`.
 */
export function compileOrExpression(table: string, expr: string, params: Params): string {
  const parts = splitTopLevel(expr);
  const compiled = parts.map((part) => {
    const lower = part.toLowerCase();
    if (lower.startsWith('and(') && part.endsWith(')')) {
      return `(${splitTopLevel(part.slice(4, -1))
        .map((p) => compileOrPart(table, p, params))
        .join(' AND ')})`;
    }
    if (lower.startsWith('or(') && part.endsWith(')')) {
      return `(${splitTopLevel(part.slice(3, -1))
        .map((p) => compileOrPart(table, p, params))
        .join(' OR ')})`;
    }
    return compileOrPart(table, part, params);
  });
  return `(${compiled.join(' OR ')})`;
}

function compileOrPart(table: string, part: string, params: Params): string {
  // col.op.value  |  col.not.op.value
  const first = part.indexOf('@wacrm/shared/db');
  if (first === -1) throw new Error(`Bad or() clause: ${part}`);
  const column = part.slice(0, first);
  let rest = part.slice(first + 1);
  let negate = false;
  if (rest.startsWith('not.')) {
    negate = true;
    rest = rest.slice(4);
  }
  const second = rest.indexOf('@wacrm/shared/db');
  const op = second === -1 ? rest : rest.slice(0, second);
  let raw: string | null = second === -1 ? null : rest.slice(second + 1);

  const col = qualify(table, column);
  let sql: string;
  if (op === 'is') {
    sql = compileOperator(col, 'is', raw === 'null' ? null : raw === 'true', params);
  } else if (op === 'in') {
    if (!raw || !raw.startsWith('(') || !raw.endsWith(')')) {
      throw new Error(`Bad in() list in or(): ${part}`);
    }
    const items = raw
      .slice(1, -1)
      .split(',')
      .map((s) => s.trim().replace(/^"|"$/g, ''));
    sql = compileOperator(col, 'in', items, params);
  } else if (op === 'like' || op === 'ilike') {
    raw = (raw ?? '').replace(/\*/g, '%');
    sql = compileOperator(col, op, raw, params);
  } else {
    sql = compileOperator(col, op, raw, params);
  }
  return negate ? `NOT (${sql})` : sql;
}

interface SplitFilters {
  /** conditions on the root table */
  root: string[];
  /** conditions on embedded tables, keyed by embed alias/table */
  embedded: Map<string, { column: string; step: FilterStep }[]>;
}

function compileFilters(table: string, filters: FilterStep[], params: Params): SplitFilters {
  const root: string[] = [];
  const embedded = new Map<string, { column: string; step: FilterStep }[]>();

  for (const step of filters) {
    if (step.op === 'or') {
      root.push(compileOrExpression(table, String(step.value), params));
      continue;
    }
    const column = step.column ?? '';
    if (column.includes('@wacrm/shared/db')) {
      const [embed, col] = column.split('@wacrm/shared/db', 2);
      const list = embedded.get(embed) ?? [];
      list.push({ column: col, step });
      embedded.set(embed, list);
      continue;
    }
    root.push(compileFilterStep(qualify(table, column), step, params));
  }
  return { root, embedded };
}

function compileFilterStep(qualifiedCol: string, step: FilterStep, params: Params): string {
  if (step.op === 'not') {
    return `NOT (${compileOperator(qualifiedCol, step.operator!, step.value, params)})`;
  }
  if (step.op === 'raw') {
    return compileOperator(qualifiedCol, step.operator!, step.value, params);
  }
  return compileOperator(qualifiedCol, step.op, step.value, params);
}

// ── embed compilation ────────────────────────────────────────────────

async function compileEmbed(
  parentTable: string,
  node: EmbedNode,
  params: Params,
  embeddedFilters: SplitFilters['embedded'],
): Promise<{ projection: string; existsCondition?: string }> {
  const rel = await resolveRelationship(parentTable, node.table, node.hint);
  const emb = node.table;

  const joinCond =
    rel.kind === 'belongs-to'
      ? rel.localColumns
          .map((c, i) => `${qualify(emb, rel.foreignColumns[i])} = ${qualify(parentTable, c)}`)
          .join(' AND ')
      : rel.localColumns
          .map((c, i) => `${qualify(emb, c)} = ${qualify(parentTable, rel.foreignColumns[i])}`)
          .join(' AND ');

  const extra = (embeddedFilters.get(node.alias) ?? embeddedFilters.get(node.table) ?? []).map(
    ({ column, step }) => compileFilterStep(qualify(emb, column), step, params),
  );
  const where = [joinCond, ...extra].join(' AND ');

  const rowJson = await buildRowJson(emb, node.children, params, embeddedFilters);

  let projection: string;
  if (rel.kind === 'belongs-to') {
    projection = `(SELECT ${rowJson} FROM ${ident(emb)} WHERE ${where} LIMIT 1) AS ${ident(node.alias)}`;
  } else {
    projection = `COALESCE((SELECT jsonb_agg(${rowJson}) FROM ${ident(emb)} WHERE ${where}), '[]'::jsonb) AS ${ident(node.alias)}`;
  }
  const existsCondition =
    node.inner || extra.length > 0
      ? `EXISTS (SELECT 1 FROM ${ident(emb)} WHERE ${where})`
      : undefined;
  return { projection, existsCondition: node.inner ? existsCondition : undefined };
}

async function buildRowJson(
  table: string,
  children: SelectNode[],
  params: Params,
  embeddedFilters: SplitFilters['embedded'],
): Promise<string> {
  const hasStar = children.some((c) => c.kind === 'star');
  const nestedEmbeds = children.filter((c): c is EmbedNode => c.kind === 'embed');
  const columns = children.filter((c): c is ColumnNode => c.kind === 'column');

  const pieces: string[] = [];
  if (hasStar) {
    pieces.push(`to_jsonb(${ident(table)})`);
  } else if (columns.length > 0) {
    const pairs = columns
      .map((c) => `'${c.alias ?? c.name}', ${qualify(table, c.name)}`)
      .join(', ');
    pieces.push(`jsonb_build_object(${pairs})`);
  }
  for (const nested of nestedEmbeds) {
    const { projection } = await compileEmbed(table, nested, params, embeddedFilters);
    // projection is "(subquery) AS alias" — rewrap as jsonb pair
    const sub = projection.slice(0, projection.lastIndexOf(' AS '));
    pieces.push(`jsonb_build_object('${nested.alias}', ${sub})`);
  }
  if (pieces.length === 0) pieces.push(`to_jsonb(${ident(table)})`);
  return pieces.join(' || ');
}

// ── statement compilation ────────────────────────────────────────────

async function castValueFor(
  table: string,
  column: string,
  value: unknown,
): Promise<{ value: unknown; cast: string }> {
  const info = await getTableInfo(table);
  const udt = info.columns.get(column);
  if (udt === 'jsonb' || udt === 'json') {
    return { value: value === null ? null : JSON.stringify(value), cast: `::${udt}` };
  }
  if (isPlainObject(value)) {
    return { value: JSON.stringify(value), cast: '::jsonb' };
  }
  return { value, cast: '' };
}

async function compileWrite(
  q: QueryDescriptor,
  params: Params,
): Promise<string> {
  const table = ident(q.table);

  const returning = async () => {
    if (!q.returning && !q.single) return '';
    const cols = q.columns ?? '*';
    const nodes = parseSelect(cols);
    if (nodes.some((n) => n.kind === 'embed')) {
      throw new Error('Embedded resources in mutation .select() are not supported');
    }
    const proj = nodes
      .map((n) =>
        n.kind === 'star'
          ? '*'
          : `${ident((n as ColumnNode).name)}${(n as ColumnNode).alias ? ` AS ${ident((n as ColumnNode).alias!)}` : ''}`,
      )
      .join(', ');
    return ` RETURNING ${proj}`;
  };

  if (q.action === 'insert' || q.action === 'upsert') {
    const rows = (Array.isArray(q.values) ? q.values : [q.values]) as Record<string, unknown>[];
    if (rows.length === 0) throw new Error('insert() with no rows');
    const columns = Object.keys(rows[0]);
    const valueRows: string[] = [];
    for (const row of rows) {
      const cells: string[] = [];
      for (const col of columns) {
        const { value, cast } = await castValueFor(q.table, col, row[col] ?? null);
        cells.push(`${params.add(value)}${cast}`);
      }
      valueRows.push(`(${cells.join(', ')})`);
    }
    let sql = `INSERT INTO ${table} (${columns.map(ident).join(', ')}) VALUES ${valueRows.join(', ')}`;
    if (q.action === 'upsert') {
      const conflictCols = q.onConflict
        ? q.onConflict.split(',').map((c) => ident(c.trim()))
        : (await getTableInfo(q.table)).primaryKey.map(ident);
      if (q.ignoreDuplicates) {
        sql += ` ON CONFLICT (${conflictCols.join(', ')}) DO NOTHING`;
      } else {
        const updates = columns
          .map(ident)
          .filter((c) => !conflictCols.includes(c))
          .map((c) => `${c} = EXCLUDED.${c}`);
        sql +=
          updates.length > 0
            ? ` ON CONFLICT (${conflictCols.join(', ')}) DO UPDATE SET ${updates.join(', ')}`
            : ` ON CONFLICT (${conflictCols.join(', ')}) DO NOTHING`;
      }
    }
    return sql + (await returning());
  }

  const { root, embedded } = compileFilters(q.table, q.filters, params);
  if (embedded.size > 0) throw new Error('Embedded-table filters are not supported on mutations');
  const where = root.length > 0 ? ` WHERE ${root.join(' AND ')}` : '';

  if (q.action === 'update') {
    const values = q.values as Record<string, unknown>;
    const sets: string[] = [];
    for (const [col, v] of Object.entries(values)) {
      const { value, cast } = await castValueFor(q.table, col, v);
      sets.push(`${ident(col)} = ${params.add(value)}${cast}`);
    }
    if (sets.length === 0) throw new Error('update() with no values');
    return `UPDATE ${table} SET ${sets.join(', ')}${where}` + (await returning());
  }

  if (q.action === 'delete') {
    return `DELETE FROM ${table}${where}` + (await returning());
  }
  throw new Error(`Unsupported action ${q.action}`);
}

async function compileSelectSql(
  q: QueryDescriptor,
  params: Params,
): Promise<{ sql: string; countSql?: string }> {
  const nodes = parseSelect(q.columns ?? '*');
  const { root, embedded } = compileFilters(q.table, q.filters, params);

  const projections: string[] = [];
  const extraConditions: string[] = [];
  for (const node of nodes) {
    if (node.kind === 'star') {
      projections.push(`${ident(q.table)}.*`);
    } else if (node.kind === 'column') {
      projections.push(
        `${qualify(q.table, node.name)}${node.alias ? ` AS ${ident(node.alias)}` : ''}`,
      );
    } else {
      const { projection, existsCondition } = await compileEmbed(q.table, node, params, embedded);
      projections.push(projection);
      if (existsCondition) extraConditions.push(existsCondition);
    }
  }

  // Filters that target an embed which is not in the projection still
  // constrain the parent rows (PostgREST semantics need the embed listed;
  // we enforce via EXISTS for any embedded filter on non-inner embeds too
  // only when the embed itself was not projected — matching observed usage).
  const embedAliases = new Set(
    nodes.filter((n): n is EmbedNode => n.kind === 'embed').map((n) => n.alias),
  );
  for (const key of embedded.keys()) {
    if (!embedAliases.has(key)) {
      throw new Error(`Filter on unknown embedded resource "${key}"`);
    }
  }

  const whereParts = [...root, ...extraConditions];
  const where = whereParts.length > 0 ? ` WHERE ${whereParts.join(' AND ')}` : '';

  let orderSql = '';
  if (q.order && q.order.length > 0) {
    const orderParts = q.order
      .filter((o) => !o.referencedTable)
      .map(
        (o) =>
          `${qualify(q.table, o.column)} ${o.ascending ? 'ASC' : 'DESC'}${
            o.nullsFirst === undefined ? '' : o.nullsFirst ? ' NULLS FIRST' : ' NULLS LAST'
          }`,
      );
    if (orderParts.length > 0) orderSql = ` ORDER BY ${orderParts.join(', ')}`;
  }

  let limitSql = '';
  if (q.single) {
    limitSql = ` LIMIT ${q.single === 'single' ? 2 : 2}`;
  } else if (q.rangeEnd !== undefined) {
    limitSql = ` LIMIT ${Math.max(0, q.rangeEnd - (q.offset ?? 0) + 1)} OFFSET ${q.offset ?? 0}`;
  } else if (q.limit !== undefined) {
    limitSql = ` LIMIT ${Math.floor(q.limit)}`;
  }

  const base = `FROM ${ident(q.table)}${where}`;
  const sql = `SELECT ${projections.join(', ')} ${base}${orderSql}${limitSql}`;
  const countSql = q.count ? `SELECT count(*)::int AS count ${base}` : undefined;
  return { sql, countSql };
}

// ── rpc ──────────────────────────────────────────────────────────────

interface FnInfo {
  retset: boolean;
  retvoid: boolean;
  scalar: boolean;
  /** argument name → type name (jsonb, uuid, _uuid, text, …) */
  argTypes: Map<string, string>;
}
const fnInfoCache = new Map<string, FnInfo>();

async function getFnInfo(fn: string): Promise<FnInfo> {
  const cached = fnInfoCache.get(fn);
  if (cached) return cached;
  const { rows } = await getPool().query<{
    proretset: boolean;
    typname: string;
    typtype: string;
    argnames: string[] | null;
    argtypes: string[] | null;
  }>(
    `SELECT p.proretset, t.typname, t.typtype,
            p.proargnames AS argnames,
            ARRAY(SELECT at.typname FROM unnest(p.proargtypes) WITH ORDINALITY AS a(oid, ord)
                  JOIN pg_type at ON at.oid = a.oid ORDER BY a.ord)::text[] AS argtypes
     FROM pg_proc p
     JOIN pg_type t ON t.oid = p.prorettype
     JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = $1
     LIMIT 1`,
    [fn],
  );
  if (!rows[0]) throw new Error(`Unknown function public.${fn}`);
  const argTypes = new Map<string, string>();
  (rows[0].argnames ?? []).forEach((name, i) => {
    const type = rows[0].argtypes?.[i];
    if (name && type) argTypes.set(name, type);
  });
  const info: FnInfo = {
    retset: rows[0].proretset,
    retvoid: rows[0].typname === 'void',
    scalar: rows[0].typtype === 'b' || rows[0].typtype === 'e',
    argTypes,
  };
  fnInfoCache.set(fn, info);
  return info;
}

async function executeRpc(
  client: PoolClient,
  fn: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (!IDENT.test(fn)) throw new Error(`Invalid function name: ${fn}`);
  const info = await getFnInfo(fn);
  const params = new Params();
  const argSql = Object.entries(args)
    .map(([k, v]) => {
      if (!IDENT.test(k)) throw new Error(`Invalid rpc argument name: ${k}`);
      const argType = info.argTypes.get(k);
      let val: unknown = v;
      let cast = '';
      if (argType === 'jsonb' || argType === 'json') {
        val = v === null ? null : JSON.stringify(v);
        cast = `::${argType}`;
      } else if (isPlainObject(v)) {
        val = JSON.stringify(v);
        cast = '::jsonb';
      } else if (argType && IDENT.test(argType.replace(/^_/, ''))) {
        // udt "_uuid" is uuid[]; cast keeps named-arg overload resolution stable
        cast = argType.startsWith('_') ? `::${argType.slice(1)}[]` : `::${argType}`;
      }
      return `${ident(k)} := ${params.add(val)}${cast}`;
    })
    .join(', ');

  if (info.retvoid) {
    await client.query(`SELECT ${ident(fn)}(${argSql})`, params.values);
    return null;
  }
  if (info.scalar && !info.retset) {
    const { rows } = await client.query(`SELECT ${ident(fn)}(${argSql}) AS result`, params.values);
    return rows[0]?.result ?? null;
  }
  const { rows } = await client.query(`SELECT * FROM ${ident(fn)}(${argSql})`, params.values);
  return info.retset ? rows : (rows[0] ?? null);
}

// ── top-level execution ──────────────────────────────────────────────

function pgError(err: unknown): PostgrestError {
  const e = err as DatabaseError & { message: string };
  const out = new Error(e.message) as PostgrestError;
  out.code = (e as { code?: string }).code ?? 'XX000';
  out.details = (e as { detail?: string }).detail ?? '';
  out.hint = (e as { hint?: string }).hint ?? '';
  return out;
}

function singleError(rows: number): PostgrestError {
  const err = new Error(
    `JSON object requested, multiple (or no) rows returned`,
  ) as PostgrestError;
  err.code = 'PGRST116';
  err.details = `Results contain ${rows} rows`;
  err.hint = '';
  return err;
}

export async function executeDescriptor(
  ctx: RlsContext,
  q: QueryDescriptor,
): Promise<QueryResult> {
  try {
    return await withRls(ctx, async (client) => {
      if (q.action === 'rpc') {
        const data = await executeRpc(client, q.table, (q.values ?? {}) as Record<string, unknown>);
        return { data, error: null, count: null, status: 200, statusText: 'OK' };
      }

      if (!IDENT.test(q.table)) throw new Error(`Invalid table: ${q.table}`);

      if (q.action === 'select') {
        const params = new Params();
        const { sql, countSql } = await compileSelectSql(q, params);
        let count: number | null = null;
        if (countSql) {
          const res = await client.query(countSql, params.values);
          count = res.rows[0]?.count ?? 0;
        }
        if (q.head) {
          return { data: null, error: null, count, status: 200, statusText: 'OK' };
        }
        const { rows } = await client.query(sql, params.values);
        return finishRows(rows, q, count);
      }

      const params = new Params();
      const sql = await compileWrite(q, params);
      const res = await client.query(sql, params.values);
      const count = q.count ? res.rowCount : null;
      if (!q.returning && !q.single) {
        return { data: null, error: null, count, status: 200, statusText: 'OK' };
      }
      return finishRows(res.rows, q, count);
    });
  } catch (err) {
    const error = pgError(err);
    if ((error as { code?: string }).code === 'PGRST116') {
      return { data: null, error, count: null, status: 406, statusText: 'Not Acceptable' };
    }
    return { data: null, error, count: null, status: 400, statusText: 'Bad Request' };
  }
}

function finishRows(
  rows: Record<string, unknown>[],
  q: QueryDescriptor,
  count: number | null,
): QueryResult {
  if (q.single === 'single') {
    if (rows.length !== 1) throw singleError(rows.length);
    return { data: rows[0], error: null, count, status: 200, statusText: 'OK' };
  }
  if (q.single === 'maybeSingle') {
    if (rows.length > 1) throw singleError(rows.length);
    return { data: rows[0] ?? null, error: null, count, status: 200, statusText: 'OK' };
  }
  return { data: rows, error: null, count, status: 200, statusText: 'OK' };
}
