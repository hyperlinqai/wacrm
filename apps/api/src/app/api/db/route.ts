import { NextRequest, NextResponse } from 'next/server';
import { executeDescriptor } from '@/lib/db/sql-compiler';
import { getSessionUser } from '@/lib/db/auth-server';
import { ANON_CONTEXT, userContext } from '@/lib/db/exec';
import { SESSION_COOKIE } from '@wacrm/shared/db/jwt';
import type { QueryDescriptor, QueryResult } from '@wacrm/shared/db/types';

// Executes browser query descriptors under the caller's RLS context —
// the stand-in for PostgREST. Sessions are checked authoritatively
// (JWT + revocation), and anonymous callers run as the `anon` role,
// which RLS restricts to nothing, exactly as before.
//
// The body is either one descriptor or an array of them. A batch is the
// same work with the per-request overhead paid once: a page that loads
// tags, custom fields, a count and a contact list used to spend four
// round trips and four `auth.users` session lookups before the first
// row was read. Descriptors in a batch still get a transaction each, so
// one failing query neither rolls back nor fails its neighbours — the
// caller gets results positionally and reads each one's `error` exactly
// as it would have from four separate responses.

/** Matches the browser's own cap; keeps one body from monopolising the pool. */
const MAX_BATCH = 25;

/**
 * Descriptors run concurrently, but not all at once. The connection
 * pool defaults to 10 clients shared by every request in the process,
 * and a batch is no reason to let one tab claim them all.
 */
const BATCH_CONCURRENCY = 5;

function errorResult(message: string, code: string, status: number): QueryResult {
  return {
    data: null,
    error: { message, code, details: '', hint: '' } as QueryResult['error'],
    count: null,
    status,
    statusText: message,
  };
}

/** Runs `tasks` with at most `limit` in flight, preserving input order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/** The route returns plain JSON, so Error instances become usable objects. */
function serialize(result: QueryResult) {
  return {
    ...result,
    error: result.error
      ? {
          message: result.error.message,
          code: result.error.code,
          details: result.error.details,
          hint: result.error.hint,
        }
      : null,
  };
}

export async function POST(request: NextRequest) {
  let body: QueryDescriptor | QueryDescriptor[];
  try {
    body = (await request.json()) as QueryDescriptor | QueryDescriptor[];
  } catch {
    return NextResponse.json(serialize(errorResult('Invalid request body', '400', 400)), {
      status: 400,
    });
  }

  // `batched` is kept separate from the narrowing so a one-descriptor
  // batch still answers with a one-element array.
  const batched = Array.isArray(body);
  const descriptors: QueryDescriptor[] = Array.isArray(body) ? body : [body];
  if (batched && (descriptors.length === 0 || descriptors.length > MAX_BATCH)) {
    return NextResponse.json(serialize(errorResult('Invalid batch size', '400', 400)), {
      status: 400,
    });
  }

  // Resolved once for the whole batch rather than once per descriptor.
  const session = await getSessionUser(request.cookies.get(SESSION_COOKIE)?.value);
  const ctx = session ? userContext(session.user.id, session.user.email) : ANON_CONTEXT;

  const results = await mapWithConcurrency(descriptors, BATCH_CONCURRENCY, (q) =>
    executeDescriptor(ctx, q),
  );

  return NextResponse.json(batched ? results.map(serialize) : serialize(results[0]));
}
