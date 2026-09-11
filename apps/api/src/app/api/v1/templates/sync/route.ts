// ============================================================
// POST /api/v1/templates/sync — pull every template from Meta into
// the local catalog (scope: templates:manage).
//
// Response: { data: { total, inserted, updated, errors[], truncated } }
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { resolveAuditUserId, ContactError } from '@/lib/api/v1/contacts';
import { syncTemplatesFromMeta, TemplateOpError } from '@/lib/whatsapp/template-ops';

export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'templates:manage');
    const auditUserId = await resolveAuditUserId(
      ctx.supabase,
      ctx.organizationId,
      ctx.accountId
    );
    const result = await syncTemplatesFromMeta(ctx.supabase, ctx.accountId, auditUserId);
    return ok(result);
  } catch (err) {
    if (err instanceof TemplateOpError) {
      return fail('template_error', err.message, err.status);
    }
    if (err instanceof ContactError) {
      return fail('internal', err.message, err.status);
    }
    return toApiErrorResponse(err);
  }
}
