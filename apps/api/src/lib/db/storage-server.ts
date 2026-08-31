import 'server-only';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getPool } from './pool';
import { withRls, type RlsContext } from './exec';

// Replaces Supabase Storage with files on a local volume. Buckets and
// their limits come from the storage.buckets rows the migrations created;
// write authorization re-implements the storage.objects RLS policies:
//   avatars    — first path segment must be the caller's user id
//   flow-media — "account-<account_id>" of a workspace the caller belongs
//                to (or the caller's own user id, legacy layout)
//   chat-media — "account-<account_id>" of the caller's workspace

function storageRoot(): string {
  return process.env.STORAGE_DIR ?? path.join(process.cwd(), 'storage-data');
}

export function publicStorageUrl(bucket: string, objectPath: string): string {
  const base = process.env.NEXT_PUBLIC_SITE_URL ?? '';
  return `${base}/api/storage/object/public/${bucket}/${objectPath}`;
}

interface BucketConfig {
  id: string;
  public: boolean;
  fileSizeLimit: number | null;
  allowedMimeTypes: string[] | null;
}

let bucketsPromise: Promise<Map<string, BucketConfig>> | null = null;

export function getBuckets(): Promise<Map<string, BucketConfig>> {
  if (!bucketsPromise) {
    bucketsPromise = getPool()
      .query<{
        id: string;
        public: boolean;
        file_size_limit: string | null;
        allowed_mime_types: string[] | null;
      }>(`SELECT id, public, file_size_limit, allowed_mime_types FROM storage.buckets`)
      .then((res) => {
        const map = new Map<string, BucketConfig>();
        for (const row of res.rows) {
          map.set(row.id, {
            id: row.id,
            public: row.public,
            fileSizeLimit: row.file_size_limit === null ? null : Number(row.file_size_limit),
            allowedMimeTypes: row.allowed_mime_types,
          });
        }
        return map;
      });
  }
  return bucketsPromise;
}

export class StorageError extends Error {
  statusCode: string;
  constructor(message: string, statusCode = '400') {
    super(message);
    this.statusCode = statusCode;
  }
}

/** Reject traversal and normalize the object path. */
export function sanitizeObjectPath(objectPath: string): string {
  const cleaned = objectPath.replace(/^\/+/, '');
  if (
    cleaned.length === 0 ||
    cleaned.includes('..') ||
    cleaned.includes('\\') ||
    cleaned.includes('\0')
  ) {
    throw new StorageError('Invalid object path', '400');
  }
  return cleaned;
}

async function assertCanWrite(
  ctx: RlsContext,
  bucket: string,
  objectPath: string,
): Promise<void> {
  if (ctx.role === 'service_role') return;
  if (ctx.role !== 'authenticated' || !ctx.claims?.sub) {
    throw new StorageError('new row violates row-level security policy', '403');
  }
  const userId = String(ctx.claims.sub);
  const firstSegment = objectPath.split('/')[0];

  if (bucket === 'avatars') {
    if (firstSegment === userId) return;
    throw new StorageError('new row violates row-level security policy', '403');
  }
  if (bucket === 'chat-media' || bucket === 'flow-media') {
    if (bucket === 'flow-media' && firstSegment === userId) return; // legacy layout
    const match = firstSegment.match(/^account-(.+)$/);
    if (match) {
      const isMember = await withRls(ctx, async (client) => {
        const { rows } = await client.query(
          `SELECT 1 FROM profiles WHERE user_id = $1 AND account_id = $2`,
          [userId, match[1]],
        );
        return rows.length > 0;
      });
      if (isMember) return;
    }
    throw new StorageError('new row violates row-level security policy', '403');
  }
  throw new StorageError(`Bucket not found: ${bucket}`, '404');
}

export async function uploadObject(
  ctx: RlsContext,
  bucket: string,
  objectPath: string,
  body: Uint8Array,
  opts: { contentType?: string; upsert?: boolean },
): Promise<{ path: string }> {
  const buckets = await getBuckets();
  const config = buckets.get(bucket);
  if (!config) throw new StorageError(`Bucket not found: ${bucket}`, '404');
  const cleaned = sanitizeObjectPath(objectPath);
  await assertCanWrite(ctx, bucket, cleaned);

  if (config.fileSizeLimit !== null && body.byteLength > config.fileSizeLimit) {
    throw new StorageError('The object exceeded the maximum allowed size', '413');
  }
  const contentType = opts.contentType ?? 'application/octet-stream';
  if (config.allowedMimeTypes && !config.allowedMimeTypes.includes(contentType)) {
    throw new StorageError(`mime type ${contentType} is not supported`, '415');
  }

  const filePath = path.join(storageRoot(), bucket, cleaned);
  if (!opts.upsert) {
    try {
      await fs.access(filePath);
      throw new StorageError('The resource already exists', '409');
    } catch (err) {
      if (err instanceof StorageError) throw err;
    }
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, body);
  // Sidecar with the declared content type so reads serve it back exactly.
  await fs.writeFile(`${filePath}.wacrm-meta`, JSON.stringify({ contentType }));
  return { path: cleaned };
}

export async function removeObjects(
  ctx: RlsContext,
  bucket: string,
  objectPaths: string[],
): Promise<void> {
  const buckets = await getBuckets();
  if (!buckets.has(bucket)) throw new StorageError(`Bucket not found: ${bucket}`, '404');
  for (const p of objectPaths) {
    const cleaned = sanitizeObjectPath(p);
    await assertCanWrite(ctx, bucket, cleaned);
    const filePath = path.join(storageRoot(), bucket, cleaned);
    await fs.rm(filePath, { force: true });
    await fs.rm(`${filePath}.wacrm-meta`, { force: true });
  }
}

export async function readObject(
  bucket: string,
  objectPath: string,
): Promise<{ body: Uint8Array; contentType: string } | null> {
  const buckets = await getBuckets();
  const config = buckets.get(bucket);
  // Only public buckets are readable through the public URL — all three
  // app buckets are public, matching the previous policies.
  if (!config || !config.public) return null;
  const cleaned = sanitizeObjectPath(objectPath);
  const filePath = path.join(storageRoot(), bucket, cleaned);
  try {
    const [body, meta] = await Promise.all([
      fs.readFile(filePath),
      fs.readFile(`${filePath}.wacrm-meta`, 'utf8').catch(() => null),
    ]);
    const contentType = meta
      ? (JSON.parse(meta).contentType as string)
      : 'application/octet-stream';
    return { body, contentType };
  } catch {
    return null;
  }
}

/** supabase-js-shaped `.storage` facade bound to an RLS context. */
export function makeStorageFacade(ctx: RlsContext) {
  return {
    from(bucket: string) {
      return {
        async upload(
          objectPath: string,
          body: Blob | ArrayBuffer | Uint8Array | Buffer,
          opts?: { contentType?: string; upsert?: boolean; cacheControl?: string },
        ) {
          try {
            let bytes: Uint8Array;
            if (body instanceof Uint8Array) bytes = body;
            else if (body instanceof ArrayBuffer) bytes = new Uint8Array(body);
            else bytes = new Uint8Array(await (body as Blob).arrayBuffer());
            const contentType =
              opts?.contentType ?? (body as Blob).type ?? 'application/octet-stream';
            const data = await uploadObject(ctx, bucket, objectPath, bytes, {
              contentType,
              upsert: opts?.upsert ?? false,
            });
            return { data, error: null };
          } catch (err) {
            const e = err as StorageError;
            return {
              data: null,
              error: { message: e.message, statusCode: e.statusCode ?? '500' },
            };
          }
        },
        getPublicUrl(objectPath: string) {
          return { data: { publicUrl: publicStorageUrl(bucket, objectPath) } };
        },
        async remove(objectPaths: string[]) {
          try {
            await removeObjects(ctx, bucket, objectPaths);
            return { data: objectPaths.map((p) => ({ name: p })), error: null };
          } catch (err) {
            const e = err as StorageError;
            return {
              data: null,
              error: { message: e.message, statusCode: e.statusCode ?? '500' },
            };
          }
        },
      };
    },
  };
}
