import { NextRequest, NextResponse } from 'next/server';
import {
  AuthApiError,
  getSessionUser,
  revokeAllSessions,
  signInWithPassword,
  signUp,
  updateUser,
} from '@/lib/db/auth-server';
import { SESSION_COOKIE, sessionCookieOptions } from '@wacrm/shared/db/jwt';
import type { Session } from '@wacrm/shared/db/types';

// Auth endpoints for the browser client: login, signup, logout, user,
// update. Sessions are stateless JWTs in an httpOnly cookie.

function errorJson(err: unknown, status = 500) {
  if (err instanceof AuthApiError) {
    return NextResponse.json(
      { data: { user: null, session: null }, error: { message: err.message, status: err.status, code: err.code } },
      { status: err.status },
    );
  }
  console.error('[auth] unexpected error', err);
  // Deployment-config problems are the overwhelming cause of 500s here;
  // surface them plainly instead of a mute "Internal error" (none of
  // these messages contain secrets).
  const msg = err instanceof Error ? err.message : '';
  let message = 'Internal error';
  if (msg.includes('DATABASE_URL')) {
    message = 'Server misconfigured: DATABASE_URL is not set';
  } else if (msg.includes('JWT_SECRET')) {
    message = 'Server misconfigured: JWT_SECRET is not set';
  } else if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|timeout/i.test(msg)) {
    message = 'Server cannot reach the database';
  } else if (/password authentication failed|no pg_hba/i.test(msg)) {
    message = 'Database rejected the server connection (check DATABASE_URL credentials)';
  }
  return NextResponse.json(
    { data: { user: null, session: null }, error: { message, status } },
    { status },
  );
}

function sessionResponse(session: Session) {
  const res = NextResponse.json({
    data: {
      // Never hand the raw token to page JS — it lives in the cookie.
      user: session.user,
      session: { user: session.user, access_token: '', expires_at: session.expires_at },
    },
    error: null,
  });
  res.cookies.set(SESSION_COOKIE, session.access_token, sessionCookieOptions());
  return res;
}

export async function POST(request: NextRequest, ctx: RouteContext<'/api/auth/[action]'>) {
  const { action } = await ctx.params;
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    /* logout has no body */
  }

  try {
    switch (action) {
      case 'login': {
        const session = await signInWithPassword(String(body.email ?? ''), String(body.password ?? ''));
        return sessionResponse(session);
      }
      case 'signup': {
        const session = await signUp(
          String(body.email ?? ''),
          String(body.password ?? ''),
          (body.data as Record<string, unknown>) ?? {},
        );
        return sessionResponse(session);
      }
      case 'logout': {
        if (body.scope === 'global') {
          const session = await getSessionUser(request.cookies.get(SESSION_COOKIE)?.value);
          if (session) await revokeAllSessions(session.user.id);
        }
        const res = NextResponse.json({ data: {}, error: null });
        res.cookies.set(SESSION_COOKIE, '', { ...sessionCookieOptions(), maxAge: 0 });
        return res;
      }
      case 'update': {
        const session = await getSessionUser(request.cookies.get(SESSION_COOKIE)?.value);
        if (!session) {
          return NextResponse.json(
            { data: { user: null }, error: { message: 'Auth session missing!', status: 401 } },
            { status: 401 },
          );
        }
        const user = await updateUser(session.user.id, {
          password: body.password === undefined ? undefined : String(body.password),
          email: body.email === undefined ? undefined : String(body.email),
          data: body.data as Record<string, unknown> | undefined,
        });
        return NextResponse.json({ data: { user }, error: null });
      }
      default:
        return NextResponse.json({ error: { message: 'Unknown action' } }, { status: 404 });
    }
  } catch (err) {
    return errorJson(err);
  }
}

export async function GET(request: NextRequest, ctx: RouteContext<'/api/auth/[action]'>) {
  const { action } = await ctx.params;
  if (action !== 'user') {
    return NextResponse.json({ error: { message: 'Unknown action' } }, { status: 404 });
  }
  const session = await getSessionUser(request.cookies.get(SESSION_COOKIE)?.value);
  return NextResponse.json({ user: session?.user ?? null });
}
