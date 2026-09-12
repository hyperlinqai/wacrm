// ============================================================
// GET  /api/v1/automations — list automations (scope: automations:read)
// POST /api/v1/automations — create one (scope: automations:manage)
//
// An automation is { name, trigger_type, trigger_config, is_active, steps[] },
// where each step is { step_type, step_config, branches? } — a `condition`
// step nests its children under branches.yes / branches.no. Activating an
// invalid configuration is refused with `issues[]` naming each problem.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { parseListParams, keysetFilter, buildPage } from '@/lib/api/v1/pagination';
import { resolveAuditUserId, ContactError } from '@/lib/api/v1/contacts';
import {
  AUTOMATION_SELECT,
  AutomationError,
  createAutomation,
} from '@/lib/api/v1/automations';

function automationFail(err: AutomationError) {
  const code = err.status === 404 ? 'not_found' : err.status >= 500 ? 'internal' : 'bad_request';
  return fail(code, err.issues?.length ? `${err.message}: ${err.issues.map(i => `${i.path} — ${i.message}`).join('; ')}` : err.message, err.status);
}

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'automations:read');
    const { limit, cursor } = parseListParams(request);
    const active = new URL(request.url).searchParams.get('active');

    let query = ctx.supabase
      .from('automations')
      .select(AUTOMATION_SELECT)
      .eq('account_id', ctx.accountId);
    if (active === 'true' || active === 'false') query = query.eq('is_active', active === 'true');

    query = query
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1);
    const kf = keysetFilter(cursor);
    if (kf) query = query.or(kf);

    const { data, error } = await query;
    if (error) {
      console.error('[api/v1/automations] list error:', error);
      return fail('internal', 'Failed to list automations', 500);
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
    const ctx = await requireApiKey(request, 'automations:manage');
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }
    const auditUserId = await resolveAuditUserId(ctx.supabase, ctx.organizationId, ctx.accountId);
    const automation = await createAutomation(
      ctx.supabase,
      ctx.accountId,
      ctx.organizationId,
      auditUserId,
      body
    );
    return ok(automation, 201);
  } catch (err) {
    if (err instanceof AutomationError) return automationFail(err);
    if (err instanceof ContactError) return fail('internal', err.message, err.status);
    return toApiErrorResponse(err);
  }
}
