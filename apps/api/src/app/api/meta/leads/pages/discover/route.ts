// ============================================================
// POST /api/meta/leads/pages/discover
//
// Step 1 of the "Connect with Facebook" flow: the browser hands over
// the short-lived user token FB.login() returned; this route lists the
// Pages that user manages so they can pick one. Nothing is stored —
// the pick comes back as POST /api/meta/leads/pages { user_access_token,
// page_id }, which does the long-lived exchange and persists.
//
// Page tokens are stripped from the response: the browser never needs
// them, and the connect route derives its own from the user token.
// ============================================================

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { listUserPages, MetaGraphError } from '@wacrm/shared/meta/lead-ads-api'

export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }

  const limit = checkRateLimit(`meta-leads:discover:${ctx.userId}`, RATE_LIMITS.adminAction)
  if (!limit.success) return rateLimitResponse(limit)

  const body = await request.json().catch(() => null)
  const token = body && typeof body === 'object' ? (body as { user_access_token?: unknown }).user_access_token : null
  if (typeof token !== 'string' || !token.trim()) {
    return NextResponse.json({ error: 'user_access_token is required' }, { status: 400 })
  }

  try {
    const pages = await listUserPages({ userAccessToken: token.trim() })
    return NextResponse.json({
      pages: pages.map((p) => ({ id: p.id, name: p.name, tasks: p.tasks ?? [] })),
    })
  } catch (err) {
    const message = err instanceof MetaGraphError ? err.message : err instanceof Error ? err.message : 'Meta API error'
    return NextResponse.json({ error: `Could not list your Facebook Pages: ${message}` }, { status: 400 })
  }
}
