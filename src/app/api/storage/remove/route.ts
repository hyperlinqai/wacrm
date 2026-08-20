import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/db/auth-server';
import { ANON_CONTEXT, userContext } from '@/lib/db/exec';
import { SESSION_COOKIE } from '@/lib/db/jwt';
import { removeObjects, StorageError } from '@/lib/db/storage-server';

export async function POST(request: NextRequest) {
  try {
    const { bucket, paths } = (await request.json()) as { bucket: string; paths: string[] };
    if (!bucket || !Array.isArray(paths) || paths.length === 0) {
      return NextResponse.json(
        { data: null, error: { message: 'bucket and paths are required', statusCode: '400' } },
        { status: 400 },
      );
    }
    const session = await getSessionUser(request.cookies.get(SESSION_COOKIE)?.value);
    const ctx = session ? userContext(session.user.id, session.user.email) : ANON_CONTEXT;
    await removeObjects(ctx, bucket, paths);
    return NextResponse.json({ data: paths.map((p) => ({ name: p })), error: null });
  } catch (err) {
    if (err instanceof StorageError) {
      return NextResponse.json(
        { data: null, error: { message: err.message, statusCode: err.statusCode } },
        { status: Number(err.statusCode) || 400 },
      );
    }
    console.error('[storage] remove failed', err);
    return NextResponse.json(
      { data: null, error: { message: 'Internal error', statusCode: '500' } },
      { status: 500 },
    );
  }
}
