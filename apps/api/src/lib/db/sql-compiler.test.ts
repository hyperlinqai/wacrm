// Regression: a global search/replace once turned the '.' separators inside
// compileOrPart / the embedded-column filter split into '@wacrm/shared/db', so
// every `.or()` expression (keyset pagination on all /api/v1 lists, inbox
// filters) failed with "Bad or() clause". Pin the PostgREST grammar here.
import { describe, it, expect } from 'vitest';
import { compileOrExpression, Params } from './sql-compiler';

describe('compileOrExpression', () => {
  it('compiles a keyset pagination filter (col.op.value with and())', () => {
    const params = new Params();
    const sql = compileOrExpression(
      'conversations',
      'created_at.lt.2026-09-08T17:34:44.943Z,and(created_at.eq.2026-09-08T17:34:44.943Z,id.lt.b8f6c5f0-42ed-4ad6-9c99-112a20ae4591)',
      params
    );
    expect(sql).toMatch(/"conversations"\."created_at" < \$1/);
    expect(sql).toMatch(/"conversations"\."created_at" = \$2 AND "conversations"\."id" < \$3/);
    expect(params.values).toEqual([
      '2026-09-08T17:34:44.943Z',
      '2026-09-08T17:34:44.943Z',
      'b8f6c5f0-42ed-4ad6-9c99-112a20ae4591',
    ]);
  });

  it('supports is.null, not., in() and ilike wildcards', () => {
    const params = new Params();
    const sql = compileOrExpression(
      'contacts',
      'assigned_agent_id.is.null,status.not.eq.closed,name.ilike.*ravi*,status.in.(open,pending)',
      params
    );
    expect(sql).toContain('IS NULL');
    expect(sql).toContain('NOT (');
    // in() lists bind as one array parameter (= ANY($n)).
    expect(params.values).toEqual(['closed', '%ravi%', ['open', 'pending']]);
  });

  it('rejects a clause without an operator', () => {
    expect(() => compileOrExpression('contacts', 'garbage', new Params())).toThrow(/Bad or\(\) clause/);
  });
});
