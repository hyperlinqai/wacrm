// ============================================================
// GET    /api/v1/templates/{id} — read one template (templates:read)
// PATCH  /api/v1/templates/{id} — edit + re-submit to Meta; allowed
//                                 for APPROVED / REJECTED / PAUSED
//                                 (templates:manage)
// DELETE /api/v1/templates/{id} — delete on Meta and locally
//                                 (templates:manage)
// Account-scoped: a foreign id → 404.
// ============================================================

import type { TemplatePayload } from '@wacrm/shared/whatsapp/template-validators';

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  deleteTemplate,
  editTemplate,
  TemplateOpError,
  TEMPLATE_UUID_RE,
  TEMPLATE_SELECT,
} from '@/lib/whatsapp/template-ops';

type Ctx = { params: Promise<{ id: string }> };

function templateFail(err: TemplateOpError) {
  const code =
    err.status === 404 ? 'not_found' : err.status >= 500 ? 'internal' : 'template_error';
  return fail(code, err.message, err.status);
}

export async function GET(request: Request, { params }: Ctx) {
  try {
    const ctx = await requireApiKey(request, 'templates:read');
    const { id } = await params;
    if (!TEMPLATE_UUID_RE.test(id)) return fail('not_found', 'Template not found', 404);

    const { data, error } = await ctx.supabase
      .from('message_templates')
      .select(TEMPLATE_SELECT)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (error) {
      console.error('[api/v1/templates] read error:', error);
      return fail('internal', 'Failed to read template', 500);
    }
    if (!data) return fail('not_found', 'Template not found', 404);
    return ok(data);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function PATCH(request: Request, { params }: Ctx) {
  try {
    const ctx = await requireApiKey(request, 'templates:manage');
    const { id } = await params;
    const payload = (await request.json().catch(() => null)) as TemplatePayload | null;
    if (!payload || typeof payload !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }
    const { template, dryRun } = await editTemplate(ctx.supabase, ctx.accountId, id, payload);
    return ok({ template, dry_run: dryRun });
  } catch (err) {
    if (err instanceof TemplateOpError) return templateFail(err);
    return toApiErrorResponse(err);
  }
}

export async function DELETE(request: Request, { params }: Ctx) {
  try {
    const ctx = await requireApiKey(request, 'templates:manage');
    const { id } = await params;
    const { dryRun } = await deleteTemplate(ctx.supabase, ctx.accountId, id);
    return ok({ deleted: true, dry_run: dryRun });
  } catch (err) {
    if (err instanceof TemplateOpError) return templateFail(err);
    return toApiErrorResponse(err);
  }
}
