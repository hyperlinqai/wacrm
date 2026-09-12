// ============================================================
// GET    /api/v1/automations/{id} — automation + its step tree (automations:read)
// PATCH  /api/v1/automations/{id} — update fields and/or replace steps (automations:manage)
// DELETE /api/v1/automations/{id} — remove it and its steps (automations:manage)
// Account-scoped: a foreign id → 404.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  AutomationError,
  deleteAutomation,
  getAutomation,
  updateAutomation,
} from '@/lib/api/v1/automations';

type Ctx = { params: Promise<{ id: string }> };

function automationFail(err: AutomationError) {
  const code = err.status === 404 ? 'not_found' : err.status >= 500 ? 'internal' : 'bad_request';
  return fail(code, err.issues?.length ? `${err.message}: ${err.issues.map(i => `${i.path} — ${i.message}`).join('; ')}` : err.message, err.status);
}

export async function GET(request: Request, { params }: Ctx) {
  try {
    const ctx = await requireApiKey(request, 'automations:read');
    const { id } = await params;
    return ok(await getAutomation(ctx.supabase, ctx.accountId, id));
  } catch (err) {
    if (err instanceof AutomationError) return automationFail(err);
    return toApiErrorResponse(err);
  }
}

export async function PATCH(request: Request, { params }: Ctx) {
  try {
    const ctx = await requireApiKey(request, 'automations:manage');
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }
    return ok(await updateAutomation(ctx.supabase, ctx.accountId, id, body));
  } catch (err) {
    if (err instanceof AutomationError) return automationFail(err);
    return toApiErrorResponse(err);
  }
}

export async function DELETE(request: Request, { params }: Ctx) {
  try {
    const ctx = await requireApiKey(request, 'automations:manage');
    const { id } = await params;
    await deleteAutomation(ctx.supabase, ctx.accountId, id);
    return ok({ deleted: true });
  } catch (err) {
    if (err instanceof AutomationError) return automationFail(err);
    return toApiErrorResponse(err);
  }
}
