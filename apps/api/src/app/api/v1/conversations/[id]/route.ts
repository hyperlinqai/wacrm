// ============================================================
// GET /api/v1/conversations/{id} — read one conversation
// (scope: conversations:read). Account-scoped: a foreign id → 404.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  CONVERSATION_SELECT,
  normalizeConversation,
} from '@wacrm/shared/inbox/conversations';
import { serializeConversation, attachConversationOrigins } from '@/lib/api/v1/conversations';
import type { Conversation } from '@wacrm/shared/types';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'conversations:read');
    const { id } = await params;

    const { data, error } = await ctx.supabase
      .from('conversations')
      .select(CONVERSATION_SELECT)
      .eq('id', id)
      .eq('organization_id', ctx.organizationId)
      .maybeSingle();

    if (error) {
      console.error('[api/v1/conversations] read error:', error);
      return fail('internal', 'Failed to read conversation', 500);
    }
    if (!data) return fail('not_found', 'Conversation not found', 404);

    const [withOrigin] = await attachConversationOrigins(ctx.supabase, ctx.organizationId, [
      serializeConversation(normalizeConversation(data as Conversation)),
    ]);
    return ok(withOrigin);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

const STATUSES = new Set(['open', 'pending', 'closed']);

// PATCH /api/v1/conversations/{id} — { status?: open|pending|closed, mark_read?: true }
// (scope: conversations:write). The two things an external inbox needs to manage a thread.
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'conversations:write');
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }
    const update: Record<string, unknown> = {};
    if (body.status !== undefined) {
      if (typeof body.status !== 'string' || !STATUSES.has(body.status)) {
        return fail('bad_request', "'status' must be open, pending or closed", 400);
      }
      update.status = body.status;
    }
    if (body.mark_read === true) update.unread_count = 0;
    if (Object.keys(update).length === 0) {
      return fail('bad_request', "Provide 'status' and/or 'mark_read'", 400);
    }
    update.updated_at = new Date().toISOString();

    const { data, error } = await ctx.supabase
      .from('conversations')
      .update(update)
      .eq('id', id)
      .eq('organization_id', ctx.organizationId)
      .select(CONVERSATION_SELECT)
      .maybeSingle();
    if (error) {
      console.error('[api/v1/conversations] update error:', error);
      return fail('internal', 'Failed to update conversation', 500);
    }
    if (!data) return fail('not_found', 'Conversation not found', 404);
    const [withOrigin] = await attachConversationOrigins(ctx.supabase, ctx.organizationId, [
      serializeConversation(normalizeConversation(data as Conversation)),
    ]);
    return ok(withOrigin);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
