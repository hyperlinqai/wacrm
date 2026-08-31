import 'server-only';
import { getPool } from './pool';
import { signJwt, verifyJwt, SESSION_MAX_AGE, type SessionClaims } from '@wacrm/shared/db/jwt';
import type { Session, User } from '@wacrm/shared/db/types';

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

interface UserRow {
  id: string;
  email: string;
  raw_user_meta_data: Record<string, unknown> | null;
  raw_app_meta_data: Record<string, unknown> | null;
  created_at: string;
  banned_until: string | null;
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    user_metadata: row.raw_user_meta_data ?? {},
    app_metadata: row.raw_app_meta_data ?? { provider: 'email', providers: ['email'] },
    created_at: row.created_at,
    aud: 'authenticated',
    role: 'authenticated',
  };
}

async function issueSession(user: User): Promise<Session> {
  const access_token = await signJwt(
    {
      sub: user.id,
      email: user.email ?? '',
      role: 'authenticated',
      full_name: (user.user_metadata?.full_name as string) ?? undefined,
    },
    SESSION_MAX_AGE,
  );
  return { user, access_token, expires_at: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE };
}

export class AuthApiError extends Error {
  status: number;
  code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Email+password login. Bcrypt verification happens in Postgres (pgcrypto). */
export async function signInWithPassword(email: string, password: string): Promise<Session> {
  const { rows } = await getPool().query<UserRow & { password_ok: boolean }>(
    `SELECT id, email, raw_user_meta_data, raw_app_meta_data, created_at, banned_until,
            (encrypted_password IS NOT NULL
             AND encrypted_password <> ''
             AND encrypted_password = crypt($2, encrypted_password)) AS password_ok
     FROM auth.users
     WHERE lower(email) = lower($1) AND deleted_at IS NULL`,
    [email, password],
  );
  const row = rows[0];
  if (!row || !row.password_ok) {
    throw new AuthApiError('Invalid login credentials', 400, 'invalid_credentials');
  }
  if (row.banned_until && new Date(row.banned_until) > new Date()) {
    throw new AuthApiError('User is banned', 403, 'user_banned');
  }
  return issueSession(toUser(row));
}

/**
 * Create a user. The on_auth_user_created trigger provisions the profile
 * and account exactly as it did under GoTrue. Signups are auto-confirmed
 * (no SMTP), matching the previous deployment's behaviour.
 */
export async function signUp(
  email: string,
  password: string,
  metadata: Record<string, unknown> = {},
): Promise<Session> {
  if (password.length < 6) {
    throw new AuthApiError('Password should be at least 6 characters.', 422, 'weak_password');
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new AuthApiError('Unable to validate email address: invalid format', 400, 'validation_failed');
  }
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<UserRow>(
      `INSERT INTO auth.users (
         id, instance_id, email, encrypted_password, email_confirmed_at,
         raw_user_meta_data, raw_app_meta_data, role, aud, created_at, updated_at
       ) VALUES (
         gen_random_uuid(), $1, lower($2), crypt($3, gen_salt('bf')), now(),
         $4::jsonb, '{"provider":"email","providers":["email"]}'::jsonb,
         'authenticated', 'authenticated', now(), now()
       )
       RETURNING id, email, raw_user_meta_data, raw_app_meta_data, created_at, banned_until`,
      [NIL_UUID, email, password, JSON.stringify(metadata)],
    );
    await client.query('COMMIT');
    return issueSession(toUser(rows[0]));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if ((err as { code?: string }).code === '23505') {
      throw new AuthApiError('User already registered', 422, 'user_already_exists');
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function getUserById(userId: string): Promise<User | null> {
  const { rows } = await getPool().query<UserRow>(
    `SELECT id, email, raw_user_meta_data, raw_app_meta_data, created_at, banned_until
     FROM auth.users WHERE id = $1 AND deleted_at IS NULL`,
    [userId],
  );
  return rows[0] ? toUser(rows[0]) : null;
}

/** Update password, email, and/or user metadata for the given user. */
export async function updateUser(
  userId: string,
  attrs: { password?: string; email?: string; data?: Record<string, unknown> },
): Promise<User> {
  if (attrs.password !== undefined && attrs.password.length < 6) {
    throw new AuthApiError('Password should be at least 6 characters.', 422, 'weak_password');
  }
  if (attrs.email !== undefined && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(attrs.email)) {
    throw new AuthApiError('Unable to validate email address: invalid format', 400, 'validation_failed');
  }
  try {
    const { rows } = await getPool().query<UserRow>(
      `UPDATE auth.users SET
         encrypted_password = CASE WHEN $2::text IS NOT NULL
           THEN crypt($2, gen_salt('bf')) ELSE encrypted_password END,
         email = COALESCE(lower($4), email),
         raw_user_meta_data = COALESCE(raw_user_meta_data, '{}'::jsonb) || COALESCE($3::jsonb, '{}'::jsonb),
         updated_at = now()
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING id, email, raw_user_meta_data, raw_app_meta_data, created_at, banned_until`,
      [
        userId,
        attrs.password ?? null,
        attrs.data ? JSON.stringify(attrs.data) : null,
        attrs.email ?? null,
      ],
    );
    if (!rows[0]) throw new AuthApiError('User not found', 404, 'user_not_found');
    return toUser(rows[0]);
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new AuthApiError(
        'A user with this email address has already been registered',
        422,
        'email_exists',
      );
    }
    throw err;
  }
}

/** Invalidate every outstanding session for a user (signOut scope:'global'). */
export async function revokeAllSessions(userId: string): Promise<void> {
  await getPool().query(
    `UPDATE auth.users SET sessions_revoked_at = now(), updated_at = now() WHERE id = $1`,
    [userId],
  );
}

/**
 * Authoritative session check: verifies the JWT AND that the user still
 * exists and has not globally signed out since the token was issued.
 */
export async function getSessionUser(
  token: string | undefined | null,
): Promise<{ user: User; claims: SessionClaims } | null> {
  const claims = await verifyJwt(token);
  if (!claims) return null;
  const { rows } = await getPool().query<UserRow & { revoked: boolean }>(
    `SELECT id, email, raw_user_meta_data, raw_app_meta_data, created_at, banned_until,
            (sessions_revoked_at IS NOT NULL AND sessions_revoked_at > to_timestamp($2)) AS revoked
     FROM auth.users WHERE id = $1 AND deleted_at IS NULL`,
    [claims.sub, claims.iat],
  );
  const row = rows[0];
  if (!row || row.revoked) return null;
  if (row.banned_until && new Date(row.banned_until) > new Date()) return null;
  return { user: toUser(row), claims };
}

/** Verify a session token and return its claims (null when invalid). */
export async function verifySession(token: string | undefined | null): Promise<SessionClaims | null> {
  return verifyJwt(token);
}
