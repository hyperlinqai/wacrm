// ============================================================
// PATCH  /api/meta/leads/pages/[id] — pause/resume, change segment tag,
//                                     or re-install the leadgen webhook
// DELETE /api/meta/leads/pages/[id] — disconnect (best-effort unsubscribe
//                                     on Meta, then delete the row; its
//                                     meta_leads cascade, contacts stay)
// ============================================================

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { decrypt } from '@/lib/whatsapp/encryption'
import { supabaseAdmin } from '@/lib/meta-leads/admin-client'
import { PAGE_PUBLIC_COLUMNS } from '@/lib/meta-leads/columns'
import { tagBelongsToAccount } from '@/lib/web-forms/segment-tag'
import { subscribePageToLeadgen, unsubscribePageApp } from '@wacrm/shared/meta/lead-ads-api'

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const { status, tag_id, resubscribe } = body as { status?: unknown; tag_id?: unknown; resubscribe?: unknown }

  const admin = supabaseAdmin()
  const { data: existing } = await admin
    .from('meta_lead_pages')
    .select('id, page_id, page_access_token')
    .eq('id', id)
    .eq('organization_id', ctx.organizationId)
    .maybeSingle()
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const update: Record<string, unknown> = {}

  if (status !== undefined) {
    if (status !== 'active' && status !== 'paused') {
      return NextResponse.json({ error: "status must be 'active' or 'paused'" }, { status: 400 })
    }
    update.status = status
  }

  if (tag_id !== undefined) {
    if (typeof tag_id === 'string') {
      if (!(await tagBelongsToAccount(admin, tag_id, ctx.accountId))) {
        return NextResponse.json({ error: 'tag_id is not a tag of this account' }, { status: 400 })
      }
      update.tag_id = tag_id
    } else if (tag_id === null) {
      update.tag_id = null
    } else {
      return NextResponse.json({ error: 'tag_id must be a tag id or null' }, { status: 400 })
    }
  }

  let subscribeError: string | null = null
  if (resubscribe === true) {
    try {
      const token = decrypt(existing.page_access_token as string)
      update.webhook_subscribed = await subscribePageToLeadgen({ pageId: existing.page_id as string, pageAccessToken: token })
    } catch (err) {
      subscribeError = err instanceof Error ? err.message : 'unknown error'
      update.webhook_subscribed = false
    }
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
  }

  const { data: page, error } = await admin
    .from('meta_lead_pages')
    .update(update)
    .eq('id', id)
    .select(PAGE_PUBLIC_COLUMNS)
    .single()
  if (error || !page) return NextResponse.json({ error: error?.message ?? 'update failed' }, { status: 500 })
  return NextResponse.json({ page, subscribe_error: subscribeError })
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }

  const admin = supabaseAdmin()
  const { data: existing } = await admin
    .from('meta_lead_pages')
    .select('id, page_id, page_access_token')
    .eq('id', id)
    .eq('organization_id', ctx.organizationId)
    .maybeSingle()
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Best-effort: stop Meta pushing leads for this Page to our app. A
  // revoked/expired token makes this fail, which must not block the
  // disconnect itself — the row is what makes the webhook act on a lead.
  try {
    const token = decrypt(existing.page_access_token as string)
    await unsubscribePageApp({ pageId: existing.page_id as string, pageAccessToken: token })
  } catch (err) {
    console.warn(`[meta-leads] unsubscribe on disconnect failed for page ${existing.page_id}:`, err)
  }

  const { error } = await admin.from('meta_lead_pages').delete().eq('id', id).eq('organization_id', ctx.organizationId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
