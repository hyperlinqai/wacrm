import { NextRequest } from 'next/server';
import { readObject } from '@/lib/db/storage-server';

// Public object reads — the URL shape getPublicUrl() hands out. All three
// app buckets are public (Meta fetches chat/flow media from here).

export async function GET(
  _request: NextRequest,
  ctx: RouteContext<'/api/storage/object/public/[bucket]/[...path]'>,
) {
  const { bucket, path } = await ctx.params;
  const object = await readObject(bucket, path.map(decodeURIComponent).join('/'));
  if (!object) return new Response('Object not found', { status: 404 });
  return new Response(Buffer.from(object.body), {
    headers: {
      'Content-Type': object.contentType,
      'Cache-Control': 'public, max-age=3600',
      'Content-Length': String(object.body.byteLength),
    },
  });
}
