// ============================================================
// GET /api/v1/broadcasts/{id}/recipients — per-recipient delivery
// status (scope: broadcasts:send).
//
// Optional `?status=pending|sent|delivered|read|replied|failed`.
// Keyset-paginated. Each row carries the contact's phone so callers
// can map results back to their own records.
// Account-scoped: a foreign broadcast id → 404.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { parseListParams, keysetFilter, buildPage } from '@/lib/api/v1/pagination';

const STATUSES = new Set(['pending', 'sent', 'delivered', 'read', 'replied', 'failed']);

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'broadcasts:send');
    const { id } = await params;
    const { limit, cursor } = parseListParams(request);
    const status = new URL(request.url).searchParams.get('status') ?? '';

    const { data: broadcast, error: bErr } = await ctx.supabase
      .from('broadcasts')
      .select('id')
      .eq('id', id)
      .eq('organization_id', ctx.organizationId)
      .maybeSingle();
    if (bErr) {
      console.error('[api/v1/broadcasts/recipients] broadcast read error:', bErr);
      return fail('internal', 'Failed to read broadcast', 500);
    }
    if (!broadcast) return fail('not_found', 'Broadcast not found', 404);

    let query = ctx.supabase
      .from('broadcast_recipients')
      .select(
        'id, status, sent_at, delivered_at, read_at, replied_at, error_message, created_at, contact:contacts(id, phone, name)'
      )
      .eq('broadcast_id', id);
    if (STATUSES.has(status)) query = query.eq('status', status);

    query = query
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1);
    const kf = keysetFilter(cursor);
    if (kf) query = query.or(kf);

    const { data, error } = await query;
    if (error) {
      console.error('[api/v1/broadcasts/recipients] list error:', error);
      return fail('internal', 'Failed to list recipients', 500);
    }
    const { items, nextCursor } = buildPage(
      (data ?? []) as unknown as Array<{ created_at: string; id: string }>,
      limit
    );
    return okList(items, nextCursor);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
