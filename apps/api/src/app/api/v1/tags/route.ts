// ============================================================
// GET  /api/v1/tags — list contact tags (scope: contacts:read)
// POST /api/v1/tags — create one (scope: contacts:write)
//
// Tags are how automations are wired up from outside: `add_tag` steps and
// `tag_added` triggers both address a tag by id, so an integrator needs to
// resolve names to ids before saving an automation.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { resolveAuditUserId, ContactError } from '@/lib/api/v1/contacts';

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'contacts:read');
    const { data, error } = await ctx.supabase
      .from('tags')
      .select('id, name, color, created_at')
      .eq('account_id', ctx.accountId)
      .order('name', { ascending: true })
      .limit(500);
    if (error) {
      console.error('[api/v1/tags] list error:', error);
      return fail('internal', 'Failed to list tags', 500);
    }
    return ok(data ?? []);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'contacts:write');
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name) return fail('bad_request', "'name' is required", 400);

    // Tag names are how humans recognise them, so reuse an existing one
    // rather than creating a second tag with the same label.
    const { data: existing } = await ctx.supabase
      .from('tags')
      .select('id, name, color, created_at')
      .eq('account_id', ctx.accountId)
      .ilike('name', name)
      .maybeSingle();
    if (existing) return ok(existing);

    const auditUserId = await resolveAuditUserId(ctx.supabase, ctx.organizationId, ctx.accountId);
    const { data, error } = await ctx.supabase
      .from('tags')
      .insert({
        account_id: ctx.accountId,
        organization_id: ctx.organizationId,
        user_id: auditUserId,
        name,
        ...(typeof body?.color === 'string' && /^#[0-9a-f]{6}$/i.test(body.color) ? { color: body.color } : {})
      })
      .select('id, name, color, created_at')
      .single();
    if (error || !data) {
      console.error('[api/v1/tags] insert error:', error);
      return fail('internal', 'Failed to create tag', 500);
    }
    return ok(data, 201);
  } catch (err) {
    if (err instanceof ContactError) return fail('internal', err.message, err.status);
    return toApiErrorResponse(err);
  }
}
