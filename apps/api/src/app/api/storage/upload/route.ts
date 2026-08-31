import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/db/auth-server';
import { ANON_CONTEXT, userContext } from '@/lib/db/exec';
import { SESSION_COOKIE } from '@wacrm/shared/db/jwt';
import { StorageError, uploadObject } from '@/lib/db/storage-server';

export async function POST(request: NextRequest) {
  try {
    const form = await request.formData();
    const bucket = String(form.get('bucket') ?? '');
    const path = String(form.get('path') ?? '');
    const upsert = form.get('upsert') === 'true';
    const file = form.get('file');
    if (!bucket || !path || !(file instanceof File)) {
      return NextResponse.json(
        { data: null, error: { message: 'bucket, path and file are required', statusCode: '400' } },
        { status: 400 },
      );
    }
    const session = await getSessionUser(request.cookies.get(SESSION_COOKIE)?.value);
    const ctx = session ? userContext(session.user.id, session.user.email) : ANON_CONTEXT;
    const data = await uploadObject(ctx, bucket, path, new Uint8Array(await file.arrayBuffer()), {
      contentType: file.type || 'application/octet-stream',
      upsert,
    });
    return NextResponse.json({ data, error: null });
  } catch (err) {
    if (err instanceof StorageError) {
      return NextResponse.json(
        { data: null, error: { message: err.message, statusCode: err.statusCode } },
        { status: Number(err.statusCode) || 400 },
      );
    }
    console.error('[storage] upload failed', err);
    return NextResponse.json(
      { data: null, error: { message: 'Internal error', statusCode: '500' } },
      { status: 500 },
    );
  }
}
