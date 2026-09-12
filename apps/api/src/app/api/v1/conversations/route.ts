// ============================================================
// GET /api/v1/conversations — list conversations (scope: conversations:read)
//
// Keyset-paginated (newest first). Filters: `?status=` (open/pending/
// closed) and `?contact_id=`. Each conversation embeds its contact +
// tags via the shared CONVERSATION_SELECT.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  parseListParams,
  keysetFilter,
  buildPage,
} from '@/lib/api/v1/pagination';
import {
  CONVERSATION_SELECT,
  normalizeConversation,
} from '@wacrm/shared/inbox/conversations';
import { serializeConversation, attachConversationOrigins } from '@/lib/api/v1/conversations';
import type { Conversation } from '@wacrm/shared/types';

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'conversations:read');
    const { limit, cursor } = parseListParams(request);
    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    const contactId = url.searchParams.get('contact_id');

    let query = ctx.supabase
      .from('conversations')
      .select(CONVERSATION_SELECT)
      .eq('organization_id', ctx.organizationId);

    if (status) query = query.eq('status', status);
    if (contactId) query = query.eq('contact_id', contactId);

    query = query
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1);

    const kf = keysetFilter(cursor);
    if (kf) query = query.or(kf);

    const { data, error } = await query;
    if (error) {
      console.error('[api/v1/conversations] list error:', error);
      return fail('internal', 'Failed to list conversations', 500);
    }

    const { items, nextCursor } = buildPage(
      (data ?? []) as Array<{ created_at: string; id: string }>,
      limit
    );
    // `origin` / `origin_flags` say which channel opened each thread (automation, broadcast,
    // inbound, agent) so an external inbox can group conversations by route.
    const serialized = items.map((r) =>
      serializeConversation(normalizeConversation(r as Conversation))
    );
    return okList(
      await attachConversationOrigins(ctx.supabase, ctx.organizationId, serialized),
      nextCursor
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
