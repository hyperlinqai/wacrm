import 'server-only';
import { getPool } from './pool';

// Column-type map for public tables, introspected once per process.
// The SQL compiler uses it to cast bound parameters (jsonb, arrays,
// enums…) the way PostgREST's schema cache did.

export interface TableInfo {
  /** column name → udt name (jsonb, uuid, text, _text, int4, …) */
  columns: Map<string, string>;
  primaryKey: string[];
}

let schemaPromise: Promise<Map<string, TableInfo>> | null = null;

async function loadSchema(): Promise<Map<string, TableInfo>> {
  const pool = getPool();
  // pg_catalog, not information_schema: the latter hides tables the
  // connecting role has no direct privileges on, and the app's pool role
  // (authenticator) only gains table access after SET LOCAL role.
  const [cols, pks] = await Promise.all([
    pool.query<{ table_name: string; column_name: string; udt_name: string }>(`
      SELECT c.relname AS table_name, a.attname AS column_name, t.typname AS udt_name
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_type t ON t.oid = a.atttypid
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v')
        AND a.attnum > 0 AND NOT a.attisdropped
    `),
    pool.query<{ table_name: string; column_name: string }>(`
      SELECT c.relname AS table_name, a.attname AS column_name
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
      WHERE i.indisprimary AND n.nspname = 'public'
      ORDER BY c.relname, k.ord
    `),
  ]);
  const map = new Map<string, TableInfo>();
  for (const row of cols.rows) {
    let info = map.get(row.table_name);
    if (!info) {
      info = { columns: new Map(), primaryKey: [] };
      map.set(row.table_name, info);
    }
    info.columns.set(row.column_name, row.udt_name);
  }
  for (const row of pks.rows) {
    map.get(row.table_name)?.primaryKey.push(row.column_name);
  }
  return map;
}

export function getSchema(): Promise<Map<string, TableInfo>> {
  if (!schemaPromise) schemaPromise = loadSchema();
  return schemaPromise;
}

export async function getTableInfo(table: string): Promise<TableInfo> {
  const info = (await getSchema()).get(table);
  if (!info) throw new Error(`Unknown table "${table}"`);
  return info;
}
