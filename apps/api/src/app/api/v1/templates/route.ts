// ============================================================
// GET  /api/v1/templates — list message templates (scope: templates:read)
// POST /api/v1/templates — create + submit a template to Meta for
//                          approval (scope: templates:manage)
//
// List filters: `?status=APPROVED` (Meta status enum), `?category=
// Marketing|Utility|Authentication`, `?search=` (name). Keyset-
// paginated like every other v1 list.
//
// POST body is the same TemplatePayload the dashboard's "New
// template" form sends:
//   { name, category, language, body_text, header_type?,
//     header_content?, header_media_url?, footer_text?, buttons?,
//     sample_values? }
// ============================================================

import type { TemplatePayload } from '@wacrm/shared/whatsapp/template-validators';

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { parseListParams, keysetFilter, buildPage } from '@/lib/api/v1/pagination';
import { resolveAuditUserId, ContactError } from '@/lib/api/v1/contacts';
import {
  submitTemplate,
  TemplateOpError,
  TEMPLATE_SELECT,
} from '@/lib/whatsapp/template-ops';

function sanitizeSearch(raw: string): string {
  return raw.replace(/[^\p{L}\p{N} _\-]/gu, '').trim();
}

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'templates:read');
    const { limit, cursor } = parseListParams(request);
    const url = new URL(request.url);
    const status = (url.searchParams.get('status') ?? '').toUpperCase();
    const category = url.searchParams.get('category') ?? '';
    const search = sanitizeSearch(url.searchParams.get('search') ?? '');

    let query = ctx.supabase
      .from('message_templates')
      .select(TEMPLATE_SELECT)
      .eq('account_id', ctx.accountId);

    if (/^[A-Z_]+$/.test(status)) query = query.eq('status', status);
    if (['Marketing', 'Utility', 'Authentication'].includes(category)) {
      query = query.eq('category', category);
    }
    if (search) query = query.ilike('name', `%${search}%`);

    query = query
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1);

    const kf = keysetFilter(cursor);
    if (kf) query = query.or(kf);

    const { data, error } = await query;
    if (error) {
      console.error('[api/v1/templates] list error:', error);
      return fail('internal', 'Failed to list templates', 500);
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

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'templates:manage');
    const payload = (await request.json().catch(() => null)) as TemplatePayload | null;
    if (!payload || typeof payload !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    const auditUserId = await resolveAuditUserId(
      ctx.supabase,
      ctx.organizationId,
      ctx.accountId
    );
    const { template, dryRun } = await submitTemplate(
      ctx.supabase,
      ctx.accountId,
      auditUserId,
      payload
    );
    return ok({ template, dry_run: dryRun }, 201);
  } catch (err) {
    if (err instanceof TemplateOpError) {
      const code =
        err.status === 429 ? 'rate_limited' : err.status >= 500 ? 'internal' : 'template_error';
      return fail(code, err.message, err.status);
    }
    if (err instanceof ContactError) {
      return fail('internal', err.message, err.status);
    }
    return toApiErrorResponse(err);
  }
}
