import { NextResponse } from 'next/server'
import {
  ForbiddenError,
  UnauthorizedError,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { syncTemplatesFromMeta, TemplateOpError } from '@/lib/whatsapp/template-ops'

/**
 * Sync message templates from Meta → local message_templates table.
 *
 * The local catalog stores Meta's status enum verbatim (APPROVED /
 * PENDING / REJECTED / PAUSED / DISABLED / IN_APPEAL / PENDING_DELETION)
 * so the edit / resubmit / delete flows can distinguish recoverable
 * states (PAUSED) from terminal ones (DISABLED) and so webhook events
 * land 1:1 without a translation table.
 *
 * Locally-created templates (no Meta counterpart) are NOT deleted —
 * they remain visible so the user can notice drift and clean up.
 *
 * The Meta + DB work lives in `lib/whatsapp/template-ops` so the public
 * API (`POST /api/v1/templates/sync`) shares it.
 */
export async function POST() {
  try {
    // Syncing rewrites the account-wide template catalog, which is
    // settings-class data: `canEditSettings` and the message_templates
    // insert/update RLS policies (migration 017) both require 'admin'.
    const { supabase, accountId, userId } = await requireRole('admin')
    const result = await syncTemplatesFromMeta(supabase, accountId, userId)
    return NextResponse.json(result)
  } catch (error) {
    // Auth failures map to 401/403 rather than being folded into the
    // generic 500 below, which surfaces `error.message` as a sync failure.
    if (
      error instanceof UnauthorizedError ||
      error instanceof ForbiddenError
    ) {
      return toErrorResponse(error)
    }
    if (error instanceof TemplateOpError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    console.error('Error syncing WhatsApp templates:', error)
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to sync templates',
      },
      { status: 500 },
    )
  }
}
