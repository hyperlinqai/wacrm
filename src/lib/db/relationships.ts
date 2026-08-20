import 'server-only';
import { getPool } from './pool';

// PostgREST resolves `parent(cols)` embeds by walking foreign keys.
// We introspect public-schema FKs once per process and answer the same
// question: given the current table and an embedded table name, is it a
// belongs-to (FK on current → object) or has-many (FK on embedded → array)?

export interface FkEdge {
  constraint: string;
  fromTable: string;
  fromColumns: string[];
  toTable: string;
  toColumns: string[];
}

let edgesPromise: Promise<FkEdge[]> | null = null;

async function loadEdges(): Promise<FkEdge[]> {
  const { rows } = await getPool().query<{
    constraint_name: string;
    from_table: string;
    from_columns: string[];
    to_table: string;
    to_columns: string[];
  }>(`
    SELECT c.conname AS constraint_name,
           rel.relname AS from_table,
           ARRAY(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
                 ORDER BY k.ord)::text[] AS from_columns,
           frel.relname AS to_table,
           ARRAY(SELECT a.attname FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum
                 ORDER BY k.ord)::text[] AS to_columns
    FROM pg_constraint c
    JOIN pg_class rel ON rel.oid = c.conrelid
    JOIN pg_class frel ON frel.oid = c.confrelid
    JOIN pg_namespace n ON n.oid = rel.relnamespace
    WHERE c.contype = 'f' AND n.nspname = 'public'
  `);
  return rows.map((r) => ({
    constraint: r.constraint_name,
    fromTable: r.from_table,
    fromColumns: r.from_columns,
    toTable: r.to_table,
    toColumns: r.to_columns,
  }));
}

export function getFkEdges(): Promise<FkEdge[]> {
  if (!edgesPromise) edgesPromise = loadEdges();
  return edgesPromise;
}

export interface Relationship {
  kind: 'belongs-to' | 'has-many';
  /** column on the CURRENT table (belongs-to) or on the EMBEDDED table (has-many) */
  localColumns: string[];
  /** the columns those reference on the other side */
  foreignColumns: string[];
}

/**
 * Resolve how `embedded` relates to `table`. An optional `hint` names the
 * FK constraint or column (PostgREST's `!hint` syntax).
 */
export async function resolveRelationship(
  table: string,
  embedded: string,
  hint?: string,
): Promise<Relationship> {
  const edges = await getFkEdges();
  const matchHint = (e: FkEdge) =>
    !hint || e.constraint === hint || e.fromColumns.includes(hint) || e.toColumns.includes(hint);

  const belongsTo = edges.filter(
    (e) => e.fromTable === table && e.toTable === embedded && matchHint(e),
  );
  const hasMany = edges.filter(
    (e) => e.fromTable === embedded && e.toTable === table && matchHint(e),
  );

  if (belongsTo.length + hasMany.length === 0) {
    throw new Error(`No foreign key relationship between "${table}" and "${embedded}"`);
  }
  if (belongsTo.length + hasMany.length > 1 && !hint) {
    throw new Error(
      `Ambiguous relationship between "${table}" and "${embedded}" — use a !hint`,
    );
  }
  if (belongsTo[0]) {
    return {
      kind: 'belongs-to',
      localColumns: belongsTo[0].fromColumns,
      foreignColumns: belongsTo[0].toColumns,
    };
  }
  return {
    kind: 'has-many',
    localColumns: hasMany[0].fromColumns,
    foreignColumns: hasMany[0].toColumns,
  };
}
