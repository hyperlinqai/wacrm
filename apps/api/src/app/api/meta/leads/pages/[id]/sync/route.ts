// ============================================================
// POST /api/meta/leads/pages/[id]/sync
//
// Pull-mode backfill: walks every lead form on the Page and imports
// leads Meta still holds (it keeps 90 days) that this CRM hasn't seen.
// Covers three real situations the push webhook can't:
//   - leads that arrived before the Page was connected,
//   - leads missed while the deployment was down / the webhook was
//     mis-configured,
//   - the operator hasn't finished the App-level Webhooks setup yet and
//     wants leads flowing today.
// Dedupe is by leadgen id inside processMetaLead, so re-running is safe.
//
// Bounded: at most SYNC_MAX_LEADS_PER_FORM per form and the route's
// maxDuration overall — a huge backlog is imported across a few clicks
// rather than one request that a proxy times out.
// ============================================================

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { decrypt } from '@/lib/whatsapp/encryption'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { supabaseAdmin } from '@/lib/meta-leads/admin-client'
import { processMetaLead, type MetaLeadPageRow } from '@/lib/meta-leads/process-lead'
import { listFormLeads, listPageLeadForms, MetaGraphError } from '@wacrm/shared/meta/lead-ads-api'

export const maxDuration = 120

const SYNC_MAX_LEADS_PER_FORM = 300
const SYNC_DEFAULT_DAYS = 90

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }

  const limit = checkRateLimit(`meta-leads:sync:${ctx.userId}`, RATE_LIMITS.adminAction)
  if (!limit.success) return rateLimitResponse(limit)

  const body = (await request.json().catch(() => ({}))) as { days?: unknown }
  const days = typeof body.days === 'number' && body.days > 0 && body.days <= 90 ? Math.floor(body.days) : SYNC_DEFAULT_DAYS
  const sinceUnix = Math.floor(Date.now() / 1000) - days * 86_400

  const admin = supabaseAdmin()
  const { data: row } = await admin
    .from('meta_lead_pages')
    .select('id, organization_id, account_id, page_id, page_name, status, tag_id, connected_by, page_access_token')
    .eq('id', id)
    .eq('organization_id', ctx.organizationId)
    .maybeSingle()
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  let token: string
  try {
    token = decrypt(row.page_access_token as string)
  } catch {
    return NextResponse.json({ error: 'Stored Page token could not be decrypted — reconnect the Page.' }, { status: 500 })
  }

  const page: MetaLeadPageRow = {
    id: row.id as string,
    organization_id: row.organization_id as string,
    account_id: row.account_id as string,
    page_id: row.page_id as string,
    page_name: row.page_name as string,
    status: row.status as string,
    tag_id: (row.tag_id as string | null) ?? null,
    connected_by: (row.connected_by as string | null) ?? null,
  }

  const summary = { forms: 0, fetched: 0, created: 0, matched: 0, duplicates: 0, unusable: 0, errors: [] as string[] }

  try {
    const forms = await listPageLeadForms({ pageId: page.page_id, pageAccessToken: token })
    summary.forms = forms.length

    for (const form of forms) {
      let leads
      try {
        leads = await listFormLeads({ formId: form.id, pageAccessToken: token, sinceUnix, max: SYNC_MAX_LEADS_PER_FORM })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unknown error'
        summary.errors.push(`Form ${form.name ?? form.id}: ${message}`)
        continue
      }
      summary.fetched += leads.length

      for (const lead of leads) {
        try {
          const outcome = await processMetaLead({
            admin,
            page,
            lead: { ...lead, form_id: lead.form_id ?? form.id },
            receivedVia: 'sync',
            formName: form.name ?? null,
          })
          if (outcome.kind === 'created') summary.created++
          else if (outcome.kind === 'matched') summary.matched++
          else if (outcome.kind === 'duplicate') summary.duplicates++
          else summary.unusable++
        } catch (err) {
          summary.errors.push(`Lead ${lead.id}: ${err instanceof Error ? err.message : 'unknown error'}`)
        }
      }
    }
  } catch (err) {
    const message = err instanceof MetaGraphError ? err.message : err instanceof Error ? err.message : 'Meta API error'
    return NextResponse.json({ error: `Could not read lead forms from Meta: ${message}`, summary }, { status: 400 })
  }

  await admin.from('meta_lead_pages').update({ last_synced_at: new Date().toISOString() }).eq('id', page.id)

  return NextResponse.json({ ok: true, days, summary })
}
