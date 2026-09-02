// ============================================================
// Meta Lead Ads — webhook payload → processMetaLead
//
// Meta's Page webhook (object: "page") delivers a `leadgen` change per
// lead carrying ids only:
//   { object: 'page', entry: [{ id: '<page_id>', time, changes: [
//       { field: 'leadgen', value: { page_id, form_id, leadgen_id, ad_id, adgroup_id, created_time } } ] }] }
// The lead's answers must then be fetched from the Graph API with the
// Page's own token — which is the row lookup by page_id below.
//
// Exported separately from the route so both webhook endpoints (the
// dedicated /api/meta/leads/webhook and the WhatsApp one, when the
// operator points a single Callback URL at it) share this code.
// ============================================================

import { decrypt } from '@/lib/whatsapp/encryption'
import { fetchLeadgenLead, MetaGraphError } from '@wacrm/shared/meta/lead-ads-api'

import { supabaseAdmin } from './admin-client'
import { processMetaLead, type MetaLeadPageRow } from './process-lead'

export interface LeadgenChangeValue {
  page_id?: string | number
  form_id?: string | number
  leadgen_id?: string | number
  ad_id?: string | number | null
  adgroup_id?: string | number | null
  created_time?: number
}

export interface MetaPageWebhookBody {
  object?: string
  entry?: Array<{
    id?: string | number
    time?: number
    // Other subscribed fields (feed, messages, …) carry different value
    // shapes; only `leadgen` is read, after the field check.
    changes?: Array<{ field?: string; value?: LeadgenChangeValue | Record<string, unknown> }>
  }>
}

export function isPageWebhookBody(body: unknown): body is MetaPageWebhookBody {
  return !!body && typeof body === 'object' && (body as { object?: unknown }).object === 'page'
}

const PAGE_SELECT = 'id, organization_id, account_id, page_id, page_name, status, tag_id, connected_by, page_access_token'

/**
 * Process every leadgen change in a Page webhook body. Never throws
 * for a single bad lead — each is logged and the rest continue, since
 * Meta retries the whole delivery on a non-2xx and we have already
 * acked it.
 */
export async function handleLeadgenWebhook(body: MetaPageWebhookBody): Promise<{ processed: number; skipped: number }> {
  let processed = 0
  let skipped = 0
  if (!Array.isArray(body.entry)) return { processed, skipped }

  const admin = supabaseAdmin()
  // Cache page rows per delivery — one webhook often batches several
  // leads for the same Page.
  const pageCache = new Map<string, (MetaLeadPageRow & { token: string }) | null>()

  async function resolvePage(pageId: string) {
    if (pageCache.has(pageId)) return pageCache.get(pageId) ?? null
    const { data, error } = await admin.from('meta_lead_pages').select(PAGE_SELECT).eq('page_id', pageId).maybeSingle()
    if (error) {
      console.error('[meta-leads/webhook] page lookup failed:', error)
      pageCache.set(pageId, null)
      return null
    }
    if (!data) {
      pageCache.set(pageId, null)
      return null
    }
    let token: string
    try {
      token = decrypt(data.page_access_token as string)
    } catch (err) {
      console.error(`[meta-leads/webhook] could not decrypt token for page ${pageId}:`, err)
      pageCache.set(pageId, null)
      return null
    }
    const row = {
      id: data.id as string,
      organization_id: data.organization_id as string,
      account_id: data.account_id as string,
      page_id: data.page_id as string,
      page_name: data.page_name as string,
      status: data.status as string,
      tag_id: (data.tag_id as string | null) ?? null,
      connected_by: (data.connected_by as string | null) ?? null,
      token,
    }
    pageCache.set(pageId, row)
    return row
  }

  for (const entry of body.entry) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'leadgen' || !change.value) continue
      const value = change.value as LeadgenChangeValue
      const leadgenId = value.leadgen_id != null ? String(value.leadgen_id) : null
      const pageId = value.page_id != null ? String(value.page_id) : entry.id != null ? String(entry.id) : null
      if (!leadgenId || !pageId) {
        skipped++
        continue
      }

      const page = await resolvePage(pageId)
      if (!page) {
        // A Page we don't know (someone else's app subscription on a
        // shared Meta app) or one whose token we can't read. Not an
        // error worth failing the delivery over.
        console.warn(`[meta-leads/webhook] no connected page for page_id=${pageId}, lead ${leadgenId} ignored`)
        skipped++
        continue
      }
      if (page.status !== 'active') {
        skipped++
        continue
      }

      try {
        const lead = await fetchLeadgenLead({ leadgenId, pageAccessToken: page.token })
        // Hand the processor the row without the plaintext token — it
        // never needs it, and it logs the page object on failure.
        const { token: _token, ...pageRow } = page
        void _token
        const outcome = await processMetaLead({ admin, page: pageRow, lead, receivedVia: 'webhook' })
        if (outcome.kind === 'duplicate') skipped++
        else processed++
      } catch (err) {
        if (err instanceof MetaGraphError) {
          console.error(`[meta-leads/webhook] Graph API error fetching lead ${leadgenId} (code ${err.code}):`, err.message)
        } else {
          console.error(`[meta-leads/webhook] failed to process lead ${leadgenId}:`, err)
        }
        skipped++
      }
    }
  }

  return { processed, skipped }
}
