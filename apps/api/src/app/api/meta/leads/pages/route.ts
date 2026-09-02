// ============================================================
// /api/meta/leads/pages — connected Facebook Pages (Lead Ads)
//
// GET  — list the organization's connected Pages (tokens stripped) plus
//        the setup facts the settings panel shows (callback URL, whether
//        the server has the Meta app credentials).
// POST — connect a Page. Two inputs are accepted:
//   { user_access_token, page_id }   — from the "Connect with Facebook"
//        button: the browser's short-lived user token is exchanged for a
//        long-lived one server-side, and the Page token is derived from it.
//   { page_id, page_access_token }   — manual: an admin pastes a Page
//        token they generated in Graph API Explorer / Business Settings.
// Either way the route validates the token against the Page, installs
// the leadgen webhook subscription on the Page, encrypts and stores the
// token, and creates the Page's segment tag.
// ============================================================

import { NextResponse } from 'next/server'

import { createClient } from '@/lib/supabase/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { encrypt } from '@/lib/whatsapp/encryption'
import { getBaseUrl } from '@/lib/http/base-url'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { supabaseAdmin } from '@/lib/meta-leads/admin-client'
import { ensureMetaPageTag } from '@/lib/meta-leads/segment-tag'
import { PAGE_PUBLIC_COLUMNS } from '@/lib/meta-leads/columns'
import {
  exchangeLongLivedUserToken,
  getPageInfo,
  listUserPages,
  subscribePageToLeadgen,
  MetaGraphError,
} from '@wacrm/shared/meta/lead-ads-api'

export async function GET(request: Request) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // RLS-scoped: meta_lead_pages_select lets any member read their own
  // organization's rows. The token column is deliberately not selected.
  const { data, error } = await supabase
    .from('meta_lead_pages')
    .select(PAGE_PUBLIC_COLUMNS)
    .order('created_at', { ascending: false })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({
    pages: data ?? [],
    setup: {
      callback_url: `${getBaseUrl(request, { logPrefix: '[meta-leads]' })}/api/meta/leads/webhook`,
      app_configured: !!(process.env.META_APP_ID && process.env.META_APP_SECRET),
      verify_token_configured: !!(
        process.env.META_LEADS_WEBHOOK_VERIFY_TOKEN || process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN
      ),
    },
  })
}

export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }

  const limit = checkRateLimit(`meta-leads:connect:${ctx.userId}`, RATE_LIMITS.adminAction)
  if (!limit.success) return rateLimitResponse(limit)

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const { page_id, page_access_token, user_access_token } = body as {
    page_id?: string
    page_access_token?: string
    user_access_token?: string
  }

  const pageId = typeof page_id === 'string' ? page_id.trim() : ''
  if (!/^\d{3,32}$/.test(pageId)) {
    return NextResponse.json({ error: 'page_id must be the numeric Facebook Page id' }, { status: 400 })
  }
  if (!page_access_token && !user_access_token) {
    return NextResponse.json({ error: 'Provide page_access_token or user_access_token' }, { status: 400 })
  }

  // ── Resolve a Page token ───────────────────────────────────────────
  let pageToken: string
  let pageName: string
  try {
    if (user_access_token) {
      const appId = process.env.META_APP_ID
      const appSecret = process.env.META_APP_SECRET
      if (!appId || !appSecret) {
        return NextResponse.json(
          { error: 'META_APP_ID and META_APP_SECRET must be set on the server to connect with Facebook Login. Use a Page access token instead.' },
          { status: 400 },
        )
      }
      const { accessToken: longLived } = await exchangeLongLivedUserToken({
        shortLivedToken: String(user_access_token),
        appId,
        appSecret,
      })
      const pages = await listUserPages({ userAccessToken: longLived })
      const match = pages.find((p) => p.id === pageId)
      if (!match) {
        return NextResponse.json(
          { error: 'That Page is not one the logged-in Facebook user manages, or the login did not grant access to it.' },
          { status: 400 },
        )
      }
      pageToken = match.access_token
      pageName = match.name
    } else {
      pageToken = String(page_access_token).trim()
      const info = await getPageInfo({ pageId, pageAccessToken: pageToken })
      if (info.id !== pageId) {
        return NextResponse.json({ error: 'That access token does not belong to this Page.' }, { status: 400 })
      }
      pageName = info.name
    }
  } catch (err) {
    const message = err instanceof MetaGraphError ? err.message : err instanceof Error ? err.message : 'Meta API error'
    return NextResponse.json({ error: `Could not verify the Page with Meta: ${message}` }, { status: 400 })
  }

  // ── Install the leadgen webhook on the Page ────────────────────────
  let webhookSubscribed = false
  let subscribeError: string | null = null
  try {
    webhookSubscribed = await subscribePageToLeadgen({ pageId, pageAccessToken: pageToken })
  } catch (err) {
    subscribeError = err instanceof Error ? err.message : 'unknown error'
    console.warn(`[meta-leads] subscribed_apps failed for page ${pageId}:`, subscribeError)
  }

  // ── Persist (upsert on page_id so re-connecting refreshes the token) ─
  const admin = supabaseAdmin()
  const { data: existing } = await admin
    .from('meta_lead_pages')
    .select('id, organization_id')
    .eq('page_id', pageId)
    .maybeSingle()
  if (existing && existing.organization_id !== ctx.organizationId) {
    return NextResponse.json(
      { error: 'This Page is already connected to a different workspace on this deployment.' },
      { status: 409 },
    )
  }

  const row = {
    account_id: ctx.accountId,
    page_id: pageId,
    page_name: pageName,
    page_access_token: encrypt(pageToken),
    status: 'active',
    webhook_subscribed: webhookSubscribed,
    connected_by: ctx.userId,
  }

  let page
  if (existing) {
    const { data, error } = await admin
      .from('meta_lead_pages')
      .update({ page_name: row.page_name, page_access_token: row.page_access_token, status: 'active', webhook_subscribed: webhookSubscribed })
      .eq('id', existing.id)
      .select(PAGE_PUBLIC_COLUMNS)
      .single()
    if (error || !data) return NextResponse.json({ error: error?.message ?? 'update failed' }, { status: 500 })
    page = data
  } else {
    const { data, error } = await admin.from('meta_lead_pages').insert(row).select(PAGE_PUBLIC_COLUMNS).single()
    if (error || !data) return NextResponse.json({ error: error?.message ?? 'insert failed' }, { status: 500 })
    page = data
  }

  try {
    page.tag_id = await ensureMetaPageTag(
      admin,
      { id: page.id as string, page_name: pageName, account_id: ctx.accountId, tag_id: page.tag_id as string | null },
      ctx.userId,
    )
  } catch (err) {
    console.error('[meta-leads] segment tag creation failed:', err)
  }

  return NextResponse.json({ page, webhook_subscribed: webhookSubscribed, subscribe_error: subscribeError }, { status: existing ? 200 : 201 })
}
