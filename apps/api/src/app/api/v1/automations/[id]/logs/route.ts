// ============================================================
// GET /api/v1/automations/{id}/logs — run history, newest first
// (scope: automations:read). `?limit=` caps at 100.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { AutomationError, listAutomationLogs } from '@/lib/api/v1/automations';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireApiKey(request, 'automations:read');
    const { id } = await params;
    const raw = Number(new URL(request.url).searchParams.get('limit') ?? 50);
    const limit = Number.isFinite(raw) ? Math.min(100, Math.max(1, raw)) : 50;
    return ok(await listAutomationLogs(ctx.supabase, ctx.accountId, id, limit));
  } catch (err) {
    if (err instanceof AutomationError) {
      return fail(err.status === 404 ? 'not_found' : 'internal', err.message, err.status);
    }
    return toApiErrorResponse(err);
  }
}
