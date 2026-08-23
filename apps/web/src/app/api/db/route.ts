import { NextRequest, NextResponse } from 'next/server';
import { executeDescriptor } from '@/lib/db/sql-compiler';
import { getSessionUser } from '@/lib/db/auth-server';
import { ANON_CONTEXT, userContext } from '@/lib/db/exec';
import { SESSION_COOKIE } from '@/lib/db/jwt';
import type { QueryDescriptor } from '@/lib/db/types';

// Executes browser query descriptors under the caller's RLS context —
// the stand-in for PostgREST. Sessions are checked authoritatively
// (JWT + revocation), and anonymous callers run as the `anon` role,
// which RLS restricts to nothing, exactly as before.

export async function POST(request: NextRequest) {
  let descriptor: QueryDescriptor;
  try {
    descriptor = (await request.json()) as QueryDescriptor;
  } catch {
    return NextResponse.json(
      { data: null, error: { message: 'Invalid request body', code: '400' }, count: null },
      { status: 400 },
    );
  }
  const session = await getSessionUser(request.cookies.get(SESSION_COOKIE)?.value);
  const ctx = session ? userContext(session.user.id, session.user.email) : ANON_CONTEXT;
  const result = await executeDescriptor(ctx, descriptor);
  // Serialize the Error instance into a plain object the client can use.
  return NextResponse.json({
    ...result,
    error: result.error
      ? {
          message: result.error.message,
          code: result.error.code,
          details: result.error.details,
          hint: result.error.hint,
        }
      : null,
  });
}
